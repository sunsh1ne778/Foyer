import { execFile } from 'node:child_process';
import type { Plugin } from 'vite';

/**
 * 开发期端点：让网页也能弹出 Windows 原生的文件夹选择框。
 *
 * 为什么非要有这么一个端点：浏览器自己的目录选择器是**故意不给真实路径**的。
 * `<input webkitdirectory>` 只能拿到 `C:\fakepath\...`，`showDirectoryPicker()`
 * 只能拿到目录名（handle 上没有任何 path 属性）。而挂载必须把 `G:\20260619`
 * 这种宿主机绝对路径写进 spec.root，所以"弹框 + 拿到路径"这两件事只能由跑在
 * Windows 上的进程来做。
 *
 * 为什么挂在 Vite 而不是 foyer 后端：`/foyer/*` 由 deploy-foyer 容器（Linux）
 * 提供，容器里弹不出 Windows 对话框；而 Vite 本来就跑在宿主机上，并且与页面
 * 同源——不必新增进程、不必新增端口、不需要 CORS、不需要安装任何东西。
 *
 * 拿不到这个端点时（生产构建、纯后端部署、远端浏览器），前端会退回网页内
 * 目录选择器，功能不缺失。
 */

const ROUTE = '/__foyer/pick-dir';

// ShowDialog 必须在 STA 线程上跑。[Console]::OutputEncoding 不能省：Windows
// PowerShell 往管道写字符串时按 OEM 代码页编码，中文与 # 会烂掉；设成 UTF8 后
// 与 Node 侧的 utf8 解码逐字节一致（实测路径含「#整理完成」仍原样往返）。
const DIALOG_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择要挂载的宿主机目录'
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`;

// 对话框只会弹在跑 Vite 的这台机器上。远端浏览器点「浏览…」如果弹到服务器那台
// 机器上，是纯粹的错乱——所以只认本机回环地址，其余一律拒绝，让前端退回网页内
// 选择器（对远端用户来说，网页内选择器才是正确的那一个）。
function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function pickDirPlugin(): Plugin {
  return {
    name: 'foyer:pick-dir',
    apply: 'serve',
    // 直接在 configureServer 里注册，而不是返回 post 钩子：Vite 的 SPA fallback
    // 会把未知路径兜成 index.html，注册在它之前才拿得到这个路由。
    configureServer(server) {
      server.middlewares.use(ROUTE, (req, res) => {
        if (!isLoopback(req.socket.remoteAddress)) {
          res.statusCode = 403;
          res.end('pick-dir 只允许本机访问');
          return;
        }
        if (process.platform !== 'win32') {
          res.statusCode = 501;
          res.end('当前平台没有原生目录选择框');
          return;
        }
        execFile(
          'powershell.exe',
          ['-NoProfile', '-STA', '-Command', DIALOG_SCRIPT],
          { encoding: 'utf8', windowsHide: true },
          (err, stdout) => {
            if (err) {
              res.statusCode = 500;
              res.end(`无法打开目录选择框: ${err.message}`);
              return;
            }
            // 取消时 stdout 为空 → path 为空串。前端据此区分"用户取消"与
            // "这台机器没有原生框"，前者什么都不做，后者才退回网页内选择器。
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ path: (stdout || '').trim() }));
          },
        );
      });
    },
  };
}
