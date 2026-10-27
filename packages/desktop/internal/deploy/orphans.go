package deploy

// 清理历史孤儿项目的工具。
//
// ## 背景
//
// 早期版本在网络抖动 / 8000119 重试时不清理旧项目，
// 导致账号下堆积了几组孤儿项目（每组 1 控制面 + 1 数据面）。
//
// 现在部署流程已修复（会清理），但**已经产生的孤儿仍需一次性清理**。
//
// ## 安全策略
//
// 只删「**在清单之外**且符合 CFPilot 命名特征」的项目：
//   - 名字以清单里记录的项目名作为前缀（如 cpdata-ux7t-li8f 派生的各种后缀）
//   - 不在任何 KV 的部署清单里
//
// 绝不删：
//   - 清单里正在使用的项目
//   - 名字完全无关的项目（如用户的 cfnext）

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// OrphanCandidate 是一个疑似孤儿项目。
type OrphanCandidate struct {
	Name    string `json:"name"`
	Reason  string `json:"reason"`
	Created string `json:"createdOn"`
}

// FindOrphans 找出疑似孤儿项目（只读，不删除）。
//
// active 是清单里正在使用的项目名集合；prefixes 是已知的项目名前缀。
func (d *Deployer) FindOrphans(ctx context.Context, active map[string]bool, prefixes []string) ([]OrphanCandidate, error) {
	projects, err := d.client.ListPagesProjects(ctx, d.opt.AccountID)
	if err != nil {
		return nil, err
	}

	var out []OrphanCandidate
	for _, p := range projects {
		if active[p.Name] {
			continue // 正在用的，绝不动
		}

		// 只考虑 CFPilot 命名特征的项目
		matched := ""
		for _, prefix := range prefixes {
			if prefix == "" {
				continue
			}
			// 项目名等于前缀，或以前缀 + "-" 开头
			if p.Name == prefix || strings.HasPrefix(p.Name, prefix+"-") {
				matched = prefix
				break
			}
		}
		if matched == "" {
			continue
		}

		out = append(out, OrphanCandidate{
			Name:    p.Name,
			Reason:  fmt.Sprintf("以 %s 开头但不在部署清单里", matched),
			Created: p.CreatedOn,
		})
	}

	// 按创建时间排序，便于用户核对
	sort.Slice(out, func(i, j int) bool { return out[i].Created < out[j].Created })
	return out, nil
}

// DeleteOrphans 删除指定的孤儿项目。
//
// 调用方必须先用 FindOrphans 展示给用户确认，**不要自动删**。
func (d *Deployer) DeleteOrphans(ctx context.Context, names []string, log func(string)) (deleted []string, failed map[string]string) {
	failed = make(map[string]string)
	for _, name := range names {
		if err := d.client.DeletePagesProject(ctx, d.opt.AccountID, name); err != nil {
			failed[name] = err.Error()
			if log != nil {
				log(fmt.Sprintf("删除 %s 失败：%v", name, err))
			}
			continue
		}
		deleted = append(deleted, name)
		if log != nil {
			log(fmt.Sprintf("已删除 %s", name))
		}
	}
	return deleted, failed
}
