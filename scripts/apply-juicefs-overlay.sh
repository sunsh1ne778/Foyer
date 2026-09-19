#!/bin/sh
set -e
SRC="${1:-}"
DST="${2:-}"
if [ -z "$SRC" ] || [ -z "$DST" ]; then
  ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
  SRC="$ROOT/overlays/juicefs"
  DST="$ROOT/third_party/juicefs"
fi
cp "$SRC/pkg/object/fastdfs.go" "$DST/pkg/object/fastdfs.go"
cp "$SRC/pkg/object/fastdfs_test.go" "$DST/pkg/object/fastdfs_test.go"
cp "$SRC/pkg/vfs/compat.go" "$DST/pkg/vfs/compat.go"
cp "$SRC/pkg/vfs/compat_test.go" "$DST/pkg/vfs/compat_test.go"
cp "$SRC/cmd/import.go" "$DST/cmd/import.go"
cp "$SRC/cmd/import_test.go" "$DST/cmd/import_test.go"
cp "$SRC/cmd/stat.go" "$DST/cmd/stat.go"
cp "$SRC/cmd/stat_test.go" "$DST/cmd/stat_test.go"
cp "$SRC/cmd/usage.go" "$DST/cmd/usage.go"
cp "$SRC/cmd/usage_test.go" "$DST/cmd/usage_test.go"
cp "$SRC/cmd/unflag.go" "$DST/cmd/unflag.go"
cp "$SRC/cmd/unflag_test.go" "$DST/cmd/unflag_test.go"
cp "$SRC/cmd/find.go" "$DST/cmd/find.go"
cp "$SRC/cmd/find_test.go" "$DST/cmd/find_test.go"

python3 - "$DST" <<'PY'
import pathlib, sys
dst = pathlib.Path(sys.argv[1])
reader = dst / "pkg/vfs/reader.go"
text = reader.read_text()
if "tryOpenCompat" not in text:
    import re
    r2, n = re.subn(
        r"func \(r \*dataReader\) Open\(inode Ino, length uint64\) FileReader \{\r?\n\tf := &fileReader\{",
        "func (r *dataReader) Open(inode Ino, length uint64) FileReader {\n\tif f := tryOpenCompat(r.m, inode, length); f != nil {\n\t\treturn f\n\t}\n\tf := &fileReader{",
        text,
        count=1,
    )
    if n != 1:
        raise SystemExit("reader.go Open() hook site not found")
    reader.write_text(r2)
main = dst / "cmd/main.go"
text = main.read_text()
changed = False
# 守卫必须带上 "()," ：main.go 里已有 cmdStatus() / cmdStats()，裸 cmdStat 会误判。
if "cmdImport()," not in text:
    import re
    text, n = re.subn(r"\t\t\tcmdSync\(\),\r?\n", "\t\t\tcmdSync(),\n\t\t\tcmdImport(),\n", text, count=1)
    if n != 1:
        raise SystemExit("main.go cmdSync() hook site not found")
    changed = True
if "cmdStat()," not in text:
    import re
    text, n = re.subn(r"\t\t\tcmdImport\(\),\r?\n", "\t\t\tcmdImport(),\n\t\t\tcmdStat(),\n", text, count=1)
    if n != 1:
        raise SystemExit("main.go cmdImport() hook site not found")
    changed = True
if "cmdUnflag()," not in text:
    import re
    text, n = re.subn(r"\t\t\tcmdStat\(\),\r?\n", "\t\t\tcmdStat(),\n\t\t\tcmdUnflag(),\n", text, count=1)
    if n != 1:
        raise SystemExit("main.go cmdStat() hook site not found")
    changed = True
if "cmdUsage()," not in text:
    import re
    text, n = re.subn(r"\t\t\tcmdStat\(\),\r?\n", "\t\t\tcmdStat(),\n\t\t\tcmdUsage(),\n", text, count=1)
    if n != 1:
        raise SystemExit("main.go cmdStat() hook site not found")
    changed = True
if "cmdFind()," not in text:
    import re
    text, n = re.subn(r"\t\t\tcmdUnflag\(\),\r?\n", "\t\t\tcmdUnflag(),\n\t\t\tcmdFind(),\n", text, count=1)
    if n != 1:
        raise SystemExit("main.go cmdUnflag() hook site not found")
    changed = True
if changed:
    main.write_text(text)
PY
echo overlay applied
