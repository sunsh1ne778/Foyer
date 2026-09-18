package driver

import (
	"fmt"
	"sync"
)

var (
	mu        sync.RWMutex
	factories = map[string]Factory{}
)

func Register(kind string, f Factory) {
	mu.Lock()
	defer mu.Unlock()
	factories[kind] = f
}

func Open(kind, id string, spec map[string]string) (Driver, error) {
	mu.RLock()
	f, ok := factories[kind]
	mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown driver kind %q", kind)
	}
	if spec == nil {
		spec = map[string]string{}
	}
	return f(id, spec)
}

func Kinds() []string {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]string, 0, len(factories))
	for k := range factories {
		out = append(out, k)
	}
	return out
}
