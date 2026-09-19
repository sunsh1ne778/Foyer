//go:build linux

package foyer

import "syscall"

// StatDisk 读物理数据盘的真实容量。挂载源是「仅导入元数据」时，卷的逻辑已用
// （DirStats 按文件长度累加）会远超物理占用，所以分母只能来自真实文件系统。
func StatDisk(path string) (DiskSpace, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return DiskSpace{}, err
	}
	bs := uint64(st.Bsize)
	total := uint64(st.Blocks) * bs
	free := uint64(st.Bavail) * bs
	return DiskSpace{Total: total, Used: total - free, Free: free}, nil
}
