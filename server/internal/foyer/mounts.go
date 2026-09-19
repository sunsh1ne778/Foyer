package foyer

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

type MountRecord struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Type      string            `json:"type"`
	Status    string            `json:"status"`
	Spec      map[string]string `json:"spec"`
	CreatedAt string            `json:"created_at"`
}

type mountStore struct {
	mu   sync.Mutex
	file string
}

func newMountStore(file string) *mountStore {
	if file == "" {
		file = os.TempDir() + "/foyer-mounts.json"
	}
	return &mountStore{file: file}
}

func (s *mountStore) list() ([]MountRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

func (s *mountStore) readLocked() ([]MountRecord, error) {
	b, err := os.ReadFile(s.file)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []MountRecord
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// upsert 插入或整体替换一条记录，并返回**落盘后的规范值**。
//
// 必须返回记录：调用方构造的 MountRecord 不含 CreatedAt，落表时才补上，
// 直接回显入参会给出空字符串。更新分支同样要保留原 CreatedAt——否则重复
// 导入同一个 name 就会把创建时间抹成零值。
func (s *mountStore) upsert(m MountRecord) (MountRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.readLocked()
	if err != nil {
		return MountRecord{}, err
	}
	found := false
	for i, x := range list {
		if x.ID == m.ID || x.Name == m.Name {
			if m.CreatedAt == "" {
				m.CreatedAt = x.CreatedAt
			}
			list[i] = m
			found = true
			break
		}
	}
	if !found {
		list = append(list, m)
	}
	if m.CreatedAt == "" {
		// 首次落表，或要覆盖的历史记录本身就没盖过时间戳。
		m.CreatedAt = time.Now().UTC().Format(time.RFC3339)
		for i := range list {
			if list[i].ID == m.ID || list[i].Name == m.Name {
				list[i].CreatedAt = m.CreatedAt
				break
			}
		}
	}
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return MountRecord{}, err
	}
	if err := os.WriteFile(s.file, b, 0644); err != nil {
		return MountRecord{}, err
	}
	return m, nil
}

func (s *mountStore) remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.readLocked()
	if err != nil {
		return err
	}
	next := list[:0]
	for _, x := range list {
		if x.ID != id && x.Name != id {
			next = append(next, x)
		}
	}
	b, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.file, b, 0644)
}

func (s *mountStore) get(id string) (MountRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.readLocked()
	if err != nil {
		return MountRecord{}, false, err
	}
	for _, x := range list {
		if x.ID == id || x.Name == id {
			return x, true, nil
		}
	}
	return MountRecord{}, false, nil
}

// update applies fn to the first record matching id (by ID or Name) and
// persists the whole table. Returns the updated record; ok=false means miss.
func (s *mountStore) update(id string, fn func(*MountRecord)) (MountRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.readLocked()
	if err != nil {
		return MountRecord{}, false, err
	}
	for i := range list {
		if list[i].ID == id || list[i].Name == id {
			fn(&list[i])
			b, err := json.MarshalIndent(list, "", "  ")
			if err != nil {
				return MountRecord{}, false, err
			}
			if err := os.WriteFile(s.file, b, 0644); err != nil {
				return MountRecord{}, false, err
			}
			return list[i], true, nil
		}
	}
	return MountRecord{}, false, nil
}
