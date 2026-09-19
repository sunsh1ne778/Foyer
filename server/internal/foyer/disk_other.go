//go:build !linux

package foyer

import (
	"errors"
	"runtime"
)

// StatDisk 在非 linux 上不可用。生产容器是 Linux；Windows 只是开发机，
// 需要能编译与跑其余测试，所以这里失败关闭而不是编一个数字。
func StatDisk(string) (DiskSpace, error) {
	return DiskSpace{}, errors.New("statfs unavailable on " + runtime.GOOS)
}
