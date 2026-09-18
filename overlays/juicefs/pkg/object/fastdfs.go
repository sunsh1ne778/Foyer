package object

import "fmt"

func init() {
	Register("fastdfs", newFastDFS)
}

func newFastDFS(endpoint, accessKey, secretKey, token string) (ObjectStorage, error) {
	return nil, fmt.Errorf("fastdfs storage is not implemented")
}
