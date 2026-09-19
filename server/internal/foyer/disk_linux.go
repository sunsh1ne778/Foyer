//go:build linux

package foyer

import "syscall"

// StatDisk 读物理数据盘的真实容量。挂载源是「仅导入元数据」时，卷的逻辑已用
// （DirStats 按文件长度累加）会远超物理占用，所以占用只能来自真实文件系统。
//
// Used 取 Blocks-Bfree（文件真实占用，与 `df` 的 Used 同口径），Free 取 Bavail
// （非 root 可写余量，与 `df` 的 Avail 同口径）。两者之和不等于 Total —— 差额是
// ext4 的保留块，不是已用空间。曾用 Bavail 反推 Used，会把保留块算成已用
// （实测 / 上多报 55 GiB），占用率因此虚高，已修正，勿改回。
func StatDisk(path string) (DiskSpace, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return DiskSpace{}, err
	}
	bs := uint64(st.Bsize)
	total := uint64(st.Blocks) * bs
	free := uint64(st.Bavail) * bs
	// Bfree > Blocks 在正常文件系统上不会出现；真出现时按 0 已用处理，
	// 避免 uint64 下溢把 Used 变成一个天文数字。
	used := uint64(0)
	if st.Bfree <= st.Blocks {
		used = total - uint64(st.Bfree)*bs
	}
	return DiskSpace{Total: total, Used: used, Free: free}, nil
}
