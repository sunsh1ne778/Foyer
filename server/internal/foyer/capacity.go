package foyer

import (
	"fmt"
	"log"
)

// CapacityOutcome 说明一次容量对齐的结果。Skipped 非空表示没动配额，且为何。
type CapacityOutcome struct {
	Applied    bool
	Skipped    string
	CapacityGB uint64
}

// EnsureCapacity 在卷未设配额时把容量设成 desiredGB（GiB），让 df/StatFS 反映真实
// 磁盘容量而不是合成值。
//
// 安全闸（关键）：format.Capacity 是硬限制——写入把 used 推过 Capacity 会直接
// ENOSPC（third_party/juicefs/pkg/meta/quota.go:262）。「仅导入元数据」会让卷的
// 逻辑已用远超物理盘（实测 1.7 TiB vs 1 TiB），所以目标低于当前已用时必须跳过。
// 宁可不设配额，也不能把卷写死。
func EnsureCapacity(cfg Config, r Runner, desiredGB uint64) (CapacityOutcome, error) {
	if desiredGB == 0 {
		return CapacityOutcome{Skipped: "目标容量为 0"}, nil
	}
	res, err := r.Usage(cfg, nil)
	if err != nil {
		return CapacityOutcome{}, err
	}
	if res.Volume.CapacitySet {
		return CapacityOutcome{Skipped: "卷已设配额，保持运维手动值"}, nil
	}
	if res.Volume.Used > desiredGB<<30 {
		return CapacityOutcome{
			Skipped: fmt.Sprintf("目标 %d GiB 低于当前已用 %d GiB（元数据导入会让逻辑用量远超物理盘）",
				desiredGB, res.Volume.Used>>30),
		}, nil
	}
	if err := r.Config(cfg, desiredGB); err != nil {
		return CapacityOutcome{}, err
	}
	return CapacityOutcome{Applied: true, CapacityGB: desiredGB}, nil
}

// EnsureVolumeCapacity 是启动期入口：读物理数据盘总量推导目标值，失败一律只告警。
// 配额问题不能挡住网关启动。
func EnsureVolumeCapacity(cfg Config, r Runner) {
	desired := cfg.VolumeCapacityGB
	if desired == 0 {
		disk, err := StatDisk(cfg.DataDisk)
		if err != nil {
			log.Printf("capacity: 跳过，读取物理盘 %s 失败: %v", cfg.DataDisk, err)
			return
		}
		desired = disk.Total >> 30
		log.Printf("capacity: 物理盘 %s 总量 %d GiB", cfg.DataDisk, desired)
	}
	out, err := EnsureCapacity(cfg, r, desired)
	if err != nil {
		log.Printf("capacity: 告警: %v", err)
		return
	}
	switch {
	case out.Applied:
		log.Printf("capacity: 已设为 %d GiB", out.CapacityGB)
	case out.Skipped != "":
		log.Printf("capacity: 跳过: %s", out.Skipped)
	}
}
