package cmd

import (
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"syscall"
	"time"

	"github.com/juicedata/juicefs/pkg/meta"
	"github.com/juicedata/juicefs/pkg/object"
	"github.com/juicedata/juicefs/pkg/utils"
	"github.com/juicedata/juicefs/pkg/vfs"
	"github.com/urfave/cli/v2"
)

// importSummary is the machine-readable form of one import run.
// Scanned counts candidate objects (directories and internal keys excluded).
// MtimeKept/MtimeMissing/ModeKept/OwnerKept apply to imported files only;
// DirMtimeKept counts directories whose source mtime could be restored.
type importSummary struct {
	DryRun       bool     `json:"dry_run"`
	Dest         string   `json:"dest"`
	Scanned      int      `json:"scanned"`
	Imported     int      `json:"imported"`
	Skipped      int      `json:"skipped"`
	MtimeKept    int      `json:"mtime_kept"`
	MtimeMissing int      `json:"mtime_missing"`
	ModeKept     int      `json:"mode_kept"`
	OwnerKept    int      `json:"owner_kept"`
	DirMtimeKept int      `json:"dir_mtime_kept"`
	Objects      []string `json:"objects,omitempty"`
}

// importSampleLimit caps how many keys a dry-run hands back to the caller.
const importSampleLimit = 50

func cmdImport() *cli.Command {
	return &cli.Command{
		Name:      "import",
		Action:    importObjects,
		Category:  "TOOL",
		Usage:     "Import existing objects as metadata-only (compatible format)",
		ArgsUsage: "META-URL SRC [DEST]",
		Description: `
Rebuild JuiceFS metadata for objects that already exist. Data is not copied.
Imported files are content-read-only; delete removes metadata only.

SRC is an object URL (file://, webdav://, minio://, s3://, …) or "/" to scan
the volume's own bucket (skipping the volume prefix used for chunks).

Examples:
$ juicefs import redis://localhost / /imported
$ juicefs import redis://localhost file:///data/photos /photos
$ juicefs import redis://localhost webdav://user:pass@host/share /dav`,
		Flags: []cli.Flag{
			&cli.BoolFlag{
				Name:  "dry-run",
				Usage: "list objects that would be imported",
			},
			&cli.BoolFlag{
				Name:  "json",
				Usage: "print a single JSON summary instead of plain text",
			},
			&cli.BoolFlag{
				Name:  "dir-mtime",
				Usage: "restore source directory mtime after import (default true)",
				Value: true,
			},
		},
	}
}

func importObjects(c *cli.Context) error {
	setup0(c, 2, 3)
	if c.Args().Len() < 2 {
		return fmt.Errorf("META-URL and SRC are required")
	}
	metaURL := c.Args().Get(0)
	src := c.Args().Get(1)
	dest := "/imported"
	if c.Args().Len() >= 3 {
		dest = c.Args().Get(2)
	}
	if !strings.HasPrefix(dest, "/") {
		dest = "/" + dest
	}

	removePassword(metaURL)
	conf := meta.DefaultConf()
	conf.NoBGJob = true
	m := meta.NewClient(metaURL, conf)
	format, err := m.Load(true)
	if err != nil {
		return err
	}
	if err := m.NewSession(false); err != nil {
		return err
	}
	defer func() { _ = m.CloseSession() }()

	var store object.ObjectStorage
	var spec vfs.BlobSpec
	skipVolume := ""
	if src == "/" || src == format.Name || src == "/"+format.Name {
		if err := format.Decrypt(); err != nil {
			return err
		}
		store, err = object.CreateStorage(strings.ToLower(format.Storage), format.Bucket, format.AccessKey, format.SecretKey, format.SessionToken)
		if err != nil {
			return err
		}
		spec = vfs.BlobSpec{
			Name:      format.Storage,
			Endpoint:  format.Bucket,
			AccessKey: format.AccessKey,
			SecretKey: format.SecretKey,
			Token:     format.SessionToken,
		}
		skipVolume = format.Name
	} else {
		store, err = vfs.OpenStorageURI(src)
		if err != nil {
			return err
		}
		spec = vfs.BlobSpec{URI: src}
	}

	blobJSON, err := json.Marshal(spec)
	if err != nil {
		return err
	}

	ctx := meta.Background()
	summary := importSummary{DryRun: c.Bool("dry-run"), Dest: dest}
	sample := make([]string, 0, importSampleLimit)
	asJSON := c.Bool("json")
	dirs := make(map[string]time.Time)
	ch, err := object.ListAllWithDelimiter(store, "", "", "", true)
	if err != nil {
		return fmt.Errorf("list source: %w", err)
	}
	for obj := range ch {
		if obj == nil {
			continue
		}
		key := obj.Key()
		if obj.IsDir() {
			// 目录条目自带源 mtime，直接记账即可；源里的空目录也只能靠它补建，
			// 因为文件路径推导不出它们。
			dkey, ok := dirKeyFromObject(key, skipVolume)
			if !ok || (dkey == "" && skipVolume != "") {
				// 卷自身的目录（chunks/、卷前缀）不参与；扫描卷桶时根目录也没有
				// 「用户选定的源目录」这层含义，不回写。
				continue
			}
			if summary.DryRun {
				if hasSourceMtime(obj.Mtime()) {
					summary.DirMtimeKept++
				}
				continue
			}
			dirs[dkey] = obj.Mtime()
			continue
		}
		if vfs.SkipInternalKey(key, skipVolume) {
			continue
		}
		summary.Scanned++
		jp := vfs.JoinImportPath(dest, key)
		if summary.DryRun {
			// dry-run 只能预判源是否提供 mtime，不能预判写入是否成功。
			if hasSourceMtime(obj.Mtime()) {
				summary.MtimeKept++
			} else {
				summary.MtimeMissing++
			}
			if len(sample) < importSampleLimit {
				sample = append(sample, obj.Key())
			}
			if !asJSON {
				fmt.Println(obj.Key(), "->", jp)
			}
			continue
		}
		st := importOne(m, ctx, jp, obj, blobJSON, &summary)
		switch st {
		case 0:
			summary.Imported++
		case syscall.EEXIST:
			summary.Skipped++
		default:
			return fmt.Errorf("import %s: %s", jp, st)
		}
	}
	if !summary.DryRun && c.Bool("dir-mtime") && len(dirs) > 0 {
		applyDirMetadata(m, ctx, dest, dirs, &summary)
	}
	summary.Objects = sample
	if asJSON {
		b, err := json.Marshal(summary)
		if err != nil {
			return err
		}
		fmt.Println(string(b))
		return nil
	}
	if summary.DryRun {
		fmt.Printf("would import %d objects into %s\n", summary.Scanned, dest)
		return nil
	}
	fmt.Printf("imported %d, skipped %d, scanned %d -> %s (mtime kept %d, missing %d, dirs %d)\n",
		summary.Imported, summary.Skipped, summary.Scanned, dest,
		summary.MtimeKept, summary.MtimeMissing, summary.DirMtimeKept)
	return nil
}

// fileMeta 是源对象能提供的元数据；零值表示源没有提供该项。
type fileMeta struct {
	Mtime  time.Time
	Mode   uint16
	Uid    uint32
	Gid    uint32
	HasUid bool
	HasGid bool
}

// hasSourceMtime 判断源时间是否可信。零值与 epoch 都要当成缺失：
// 多个对象存储后端用 time.Unix(0, 0) 表示"没有时间"（如 CommonPrefixes），
// 它不满足 IsZero()，直接写下去会把文件变成 1970 年。
func hasSourceMtime(mt time.Time) bool {
	return !mt.IsZero() && mt.Unix() > 0
}

// metadataFor 从源对象推导可保留的元数据。
// lookupUser / lookupGroup 为 nil 时跳过属主解析（dry-run 不需要）。
func metadataFor(obj object.Object, lookupUser, lookupGroup func(string) int) fileMeta {
	var fm fileMeta
	if mt := obj.Mtime(); hasSourceMtime(mt) {
		fm.Mtime = mt
	}
	f, ok := obj.(object.File)
	if !ok {
		return fm
	}
	fm.Mode = uint16(f.Mode().Perm() &^ 0222) // 内容直读外部源，写位只会骗人，直接去掉
	if lookupUser != nil {
		if uid := lookupUser(f.Owner()); uid >= 0 {
			fm.Uid, fm.HasUid = uint32(uid), true
		}
	}
	if lookupGroup != nil {
		if gid := lookupGroup(f.Group()); gid >= 0 {
			fm.Gid, fm.HasGid = uint32(gid), true
		}
	}
	return fm
}

// ImportDirPath 把源目录键（可能带尾部 "/"）映射为目标卷的绝对路径。
func ImportDirPath(dest, key string) string {
	return path.Clean(vfs.JoinImportPath(dest, strings.TrimSuffix(key, "/")))
}

// dirKeyFromObject 把目录对象键映射成相对目录键：去掉尾部 "/"，源根目录得到 ""。
// ok 为 false 表示该目录属于卷自身（chunks/ 或卷前缀），不参与回写。
func dirKeyFromObject(key, volume string) (string, bool) {
	d := strings.TrimSuffix(key, "/")
	if vfs.SkipInternalDirKey(d, volume) {
		return "", false
	}
	return d, true
}

func importOne(m meta.Meta, ctx meta.Context, jpath string, obj object.Object, blobJSON []byte, summary *importSummary) syscall.Errno {
	parent, st := mkdirParents(m, ctx, path.Dir(jpath))
	if st != 0 {
		return st
	}
	fm := metadataFor(obj, utils.LookupUser, utils.LookupGroup)
	mode := uint16(0444) // 源没有 mode（对象存储）时的回退
	if fm.Mode != 0 {
		mode = fm.Mode
	}
	name := path.Base(jpath)
	var inode meta.Ino
	var attr meta.Attr
	st = m.Create(ctx, parent, name, mode, 0000, syscall.O_EXCL, &inode, &attr)
	if st == syscall.EEXIST {
		return syscall.EEXIST
	}
	if st != 0 {
		return st
	}
	if fm.Mode != 0 {
		summary.ModeKept++
	}
	_ = m.Close(ctx, inode)
	if st = m.Truncate(ctx, inode, 0, uint64(obj.Size()), &attr, true); st != 0 {
		return st
	}
	// 元数据（时间、属主）必须写在这里：内容只读靠 0444，不靠 immutable。
	applyFileMetadata(m, ctx, inode, fm, summary)
	if st = m.SetXattr(ctx, inode, vfs.ObjectXattr, []byte(obj.Key()), 0); st != 0 {
		return st
	}
	if st = m.SetXattr(ctx, inode, vfs.BlobXattr, blobJSON, 0); st != 0 {
		return st
	}
	// 刻意不设 FlagImmutable。导入的内容由 jfs.blob 指向外部源、经 compat reader 直读，
	// 0444 已拦住普通写入；而 immutable 会让 meta 的 unlink 直接回 EPERM
	// （pkg/meta/redis.go：attr.Flags&(FlagAppend|FlagImmutable) != 0 -> EPERM），
	// 于是导入的文件永远删不掉——S3 网关还会把失败吞成 204，看起来像成功。
	return 0
}

// applyFileMetadata 逐项 best-effort 写入源元数据：任何一项失败都只影响计数，不中断导入。
// 元数据没保留不影响内容可读，不该让整个导入失败。
func applyFileMetadata(m meta.Meta, ctx meta.Context, inode meta.Ino, fm fileMeta, summary *importSummary) {
	if fm.Mtime.IsZero() {
		summary.MtimeMissing++
	} else {
		attr := meta.Attr{Mtime: fm.Mtime.Unix(), Mtimensec: uint32(fm.Mtime.Nanosecond())}
		if st := m.SetAttr(ctx, inode, meta.SetAttrMtime, 0, &attr); st == 0 {
			summary.MtimeKept++
		} else {
			logger.Debugf("keep mtime of inode %d: %s", inode, st)
			summary.MtimeMissing++
		}
	}
	if !fm.HasUid && !fm.HasGid {
		return
	}
	set := uint16(0)
	if fm.HasUid {
		set |= meta.SetAttrUID
	}
	if fm.HasGid {
		set |= meta.SetAttrGID
	}
	attr := meta.Attr{Uid: fm.Uid, Gid: fm.Gid}
	if st := m.SetAttr(ctx, inode, set, 0, &attr); st == 0 {
		summary.OwnerKept++
	} else {
		logger.Debugf("keep owner of inode %d: %s", inode, st)
	}
}

// applyDirMetadata 补建源里的目录并回写它们的 mtime。
// 分两阶段执行：先把目录结构建全（源里的空目录只能在这里建），再统一写时间。
// 顺序不可合并——建目录会把父目录的 mtime 刷成当前时间，所以所有 mkdir 都必须
// 早于所有 SetAttr；同理本函数必须晚于文件导入。
// 目录 mode 维持 mkdirParents 的 0755，不沿用源权限位：源目录若是 0700，
// 照搬会让网关和挂载点整体不可读。
func applyDirMetadata(m meta.Meta, ctx meta.Context, dest string, dirs map[string]time.Time, summary *importSummary) {
	keys := make([]string, 0, len(dirs))
	for key := range dirs {
		keys = append(keys, key)
	}
	inodes := make(map[string]meta.Ino, len(keys))
	for _, key := range keys {
		if inode, st := mkdirParents(m, ctx, ImportDirPath(dest, key)); st == 0 {
			inodes[key] = inode
		} else {
			logger.Debugf("create imported dir %s: %s", key, st)
		}
	}
	for _, key := range keys {
		inode, ok := inodes[key]
		if !ok || !hasSourceMtime(dirs[key]) {
			continue
		}
		attr := meta.Attr{Mtime: dirs[key].Unix(), Mtimensec: uint32(dirs[key].Nanosecond())}
		if st := m.SetAttr(ctx, inode, meta.SetAttrMtime, 0, &attr); st == 0 {
			summary.DirMtimeKept++
		} else {
			logger.Debugf("keep mtime of dir %s: %s", key, st)
		}
	}
}

func mkdirParents(m meta.Meta, ctx meta.Context, dir string) (meta.Ino, syscall.Errno) {
	dir = path.Clean(dir)
	if dir == "/" || dir == "." {
		return meta.RootInode, 0
	}
	parent := meta.RootInode
	for _, name := range strings.Split(strings.Trim(dir, "/"), "/") {
		if name == "" {
			continue
		}
		var inode meta.Ino
		var attr meta.Attr
		st := m.Mkdir(ctx, parent, name, 0755, 0000, 0, &inode, &attr)
		if st == syscall.EEXIST {
			st = m.Lookup(ctx, parent, name, &inode, &attr, false)
		}
		if st != 0 {
			return 0, st
		}
		parent = inode
	}
	return parent, 0
}
