package object

import "testing"

func TestFastDFSRegisteredNotImplemented(t *testing.T) {
	_, err := CreateStorage("fastdfs", "http://x", "", "", "")
	if err == nil || err.Error() != "fastdfs storage is not implemented" {
		t.Fatalf("err=%v", err)
	}
}
