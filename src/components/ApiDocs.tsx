import React, { useState } from 'react';
import {
  BookOpen,
  Code,
  Copy,
  Check,
  Search,
  Zap,
  ShieldCheck,
  Server,
  Play,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Database,
  Layers,
  FileText,
  Send,
  Terminal,
  ExternalLink
} from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';

interface ApiEndpoint {
  id: string;
  category: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  title: string;
  description: string;
  params?: { name: string; type: string; required: boolean; in: 'query' | 'path' | 'header'; desc: string }[];
  requestBody?: string;
  response200?: string;
  responseAlt?: { code: number; desc: string; body?: string };
  codeSnippets: {
    curl: string;
    go: string;
    java: string;
    python: string;
  };
}

const API_ENDPOINTS: ApiEndpoint[] = [
  {
    id: 'auth-login',
    category: '认证鉴权',
    method: 'POST',
    path: '/v1/login',
    title: '系统认证换取 JWT Token',
    description: '业务系统通过服务端预置的用户名与凭据换取短期 Bearer Token，后续所有文件操作均在 Authorization 头中携带此 Token。',
    requestBody: `{
  "username": "biz-order-system",
  "password": "YOUR_SERVICE_SECRET"
}`,
    response200: `{
  "code": 0,
  "message": "success",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires_in": 86400,
    "token_type": "Bearer"
  }
}`,
    codeSnippets: {
      curl: `curl -X POST "http://filestore.internal:8090/v1/login" \\
  -H "Content-Type: application/json" \\
  -d '{"username":"biz-service","password":"SECRET_KEY"}'`,
      go: `reqBody, _ := json.Marshal(map[string]string{
    "username": "biz-service",
    "password": "SECRET_KEY",
})
resp, err := http.Post("http://filestore.internal:8090/v1/login", "application/json", bytes.NewBuffer(reqBody))`,
      java: `HttpHeaders headers = new HttpHeaders();
headers.setContentType(MediaType.APPLICATION_JSON);
Map<String, String> body = Map.of("username", "biz-service", "password", "SECRET_KEY");
HttpEntity<Map<String, String>> request = new HttpEntity<>(body, headers);
ResponseEntity<LoginResponse> resp = restTemplate.postForEntity("http://filestore.internal:8090/v1/login", request, LoginResponse.class);`,
      python: `import requests

resp = requests.post("http://filestore.internal:8090/v1/login", json={
    "username": "biz-service",
    "password": "SECRET_KEY"
})
token = resp.json()["data"]["token"]`
    }
  },
  {
    id: 'fs-list',
    category: '文件目录操作',
    method: 'GET',
    path: '/v1/fs/list',
    title: '查询目录子节点列表 (只走 PG 索引)',
    description: '通过统一 mount:path 语法查询指定目录下一级的所有子文件与子目录。请求直接命中 PostgreSQL 投影索引表 (fs_nodes)，高并发零穿透底层存储。',
    params: [
      { name: 'p', type: 'string', required: true, in: 'query', desc: '统一路径语法，例如 photos:/2026 或 photos:/' },
      { name: 'page', type: 'integer', required: false, in: 'query', desc: '分页页码，默认 1' },
      { name: 'limit', type: 'integer', required: false, in: 'query', desc: '每页条数，默认 50，最大 500' }
    ],
    response200: `{
  "code": 0,
  "data": {
    "ref": "photos:/2026",
    "total": 2,
    "items": [
      {
        "name": "summit_keynote.mp4",
        "key": "/2026/summit_keynote.mp4",
        "is_dir": false,
        "size": 320490200,
        "etag": "\\"aa11bb22cc33dd44ee55\\"",
        "mtime": "2026-03-16T18:00:00Z",
        "tags": ["峰会", "4K60fps"]
      },
      {
        "name": "group_photo_raw.dng",
        "key": "/2026/group_photo_raw.dng",
        "is_dir": false,
        "size": 48201940,
        "etag": "\\"77c8d9e0f1a2b3c4d5e6\\"",
        "mtime": "2026-03-16T18:40:00Z",
        "tags": ["RAW原片"]
      }
    ]
  }
}`,
    codeSnippets: {
      curl: `curl -X GET "http://filestore.internal:8090/v1/fs/list?p=photos:/2026" \\
  -H "Authorization: Bearer $FILESTORE_TOKEN"`,
      go: `req, _ := http.NewRequest("GET", "http://filestore.internal:8090/v1/fs/list?p=photos:/2026", nil)
req.Header.Set("Authorization", "Bearer " + token)
resp, err := http.DefaultClient.Do(req)`,
      java: `HttpHeaders headers = new HttpHeaders();
headers.setBearerAuth(token);
HttpEntity<?> entity = new HttpEntity<>(headers);
ResponseEntity<String> resp = restTemplate.exchange(
    "http://filestore.internal:8090/v1/fs/list?p=photos:/2026",
    HttpMethod.GET, entity, String.class
);`,
      python: `import requests
headers = {"Authorization": f"Bearer {token}"}
resp = requests.get("http://filestore.internal:8090/v1/fs/list", params={"p": "photos:/2026"}, headers=headers)`
    }
  },
  {
    id: 'fs-stat',
    category: '文件目录操作',
    method: 'GET',
    path: '/v1/fs/stat',
    title: '获取文件元数据与扩展属性',
    description: '返回指定文件的物理属性 (大小、修改时间、ETag) 以及附加在 PostgreSQL 中的业务标签 (tags) 和自定义键值 (custom_meta)。',
    params: [
      { name: 'p', type: 'string', required: true, in: 'query', desc: '文件统一路径，例如 photos:/2026/summit_keynote.mp4' }
    ],
    response200: `{
  "code": 0,
  "data": {
    "mount": "photos",
    "key": "/2026/summit_keynote.mp4",
    "name": "summit_keynote.mp4",
    "size": 320490200,
    "etag": "\\"aa11bb22cc33dd44ee55\\"",
    "is_dir": false,
    "mtime": "2026-03-16T18:00:00Z",
    "tags": ["峰会", "4K60fps"],
    "custom_meta": {
      "camera": "Sony A7S3",
      "resolution": "3840x2160"
    }
  }
}`,
    codeSnippets: {
      curl: `curl -X GET "http://filestore.internal:8090/v1/fs/stat?p=photos:/2026/summit_keynote.mp4" \\
  -H "Authorization: Bearer $FILESTORE_TOKEN"`,
      go: `req, _ := http.NewRequest("GET", "http://filestore.internal:8090/v1/fs/stat?p=photos:/2026/summit_keynote.mp4", nil)
req.Header.Set("Authorization", "Bearer " + token)
resp, _ := http.DefaultClient.Do(req)`,
      java: `restTemplate.exchange("http://filestore.internal:8090/v1/fs/stat?p=photos:/2026/summit_keynote.mp4", HttpMethod.GET, new HttpEntity<>(headers), String.class);`,
      python: `requests.get("http://filestore.internal:8090/v1/fs/stat", params={"p": "photos:/2026/summit_keynote.mp4"}, headers=headers)`
    }
  },
  {
    id: 'fs-get',
    category: '数据读取与传输',
    method: 'GET',
    path: '/v1/fs',
    title: '读取/下载文件内容 (307 直传卸载)',
    description: '下载文件的统一入口。如果底层驱动具备 presign 能力 (如 S3, OSS, MinIO)，网关将立即返回 HTTP 307 重定向至云存储直连链接；若底层无签名能力 (如本地磁盘)，网关将进行流式代理传输。',
    params: [
      { name: 'p', type: 'string', required: true, in: 'query', desc: '文件统一路径，例如 photos:/2026/summit_keynote.mp4' }
    ],
    responseAlt: {
      code: 307,
      desc: '307 Temporary Redirect (S3/OSS 直连卸载)',
      body: `HTTP/1.1 307 Temporary Redirect
Location: https://prod-bucket.s3.amazonaws.com/2026/summit_keynote.mp4?X-Amz-Signature=...
X-VFS-Strategy: direct-presigned`
    },
    codeSnippets: {
      curl: `curl -L -X GET "http://filestore.internal:8090/v1/fs?p=photos:/2026/summit_keynote.mp4" \\
  -H "Authorization: Bearer $FILESTORE_TOKEN" \\
  -o "summit_keynote.mp4"`,
      go: `// http.Client 默认自动跟随 307 重定向直连 S3 下载
resp, err := http.Get("http://filestore.internal:8090/v1/fs?p=photos:/2026/summit_keynote.mp4")`,
      java: `// RestTemplate 或 HttpClient 自动跟随 307 重定向
ResponseEntity<Resource> response = restTemplate.getForEntity("http://filestore.internal:8090/v1/fs?p=photos:/2026/summit_keynote.mp4", Resource.class);`,
      python: `import requests
# allow_redirects=True 自动跟随 307 重定向直连存储
resp = requests.get("http://filestore.internal:8090/v1/fs", params={"p": "photos:/2026/summit_keynote.mp4"}, headers=headers, allow_redirects=True)`
    }
  },
  {
    id: 'fs-copy',
    category: '文件编排管理',
    method: 'POST',
    path: '/v1/fs/copy',
    title: '拷贝文件 (同源瞬时/跨源异步队列)',
    description: '将文件从源路径拷贝至目标路径。同挂载内调用原生底层 Copy API (毫秒级完成)；跨挂载自动下发 Asynq 队列后台流式拷贝，并返回 HTTP 202 Accepted 及 job_id。',
    requestBody: `{
  "src": "photos:/2026/summit_keynote.mp4",
  "dst": "nas-backup:/archive/summit_keynote.mp4"
}`,
    response200: `{
  "code": 0,
  "message": "跨源流式复制已提交至 Asynq 队列",
  "data": {
    "job_id": "job-copy-8821",
    "status": "queued",
    "async": true
  }
}`,
    codeSnippets: {
      curl: `curl -X POST "http://filestore.internal:8090/v1/fs/copy" \\
  -H "Authorization: Bearer $FILESTORE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"src":"photos:/2026/summit_keynote.mp4","dst":"nas-backup:/archive/summit_keynote.mp4"}'`,
      go: `body, _ := json.Marshal(map[string]string{"src": "photos:/2026/a.jpg", "dst": "nas:/b.jpg"})
http.Post("http://filestore.internal:8090/v1/fs/copy", "application/json", bytes.NewBuffer(body))`,
      java: `restTemplate.postForEntity("http://filestore.internal:8090/v1/fs/copy", new HttpEntity<>(Map.of("src", "photos:/a.jpg", "dst", "nas:/b.jpg"), headers), String.class);`,
      python: `requests.post("http://filestore.internal:8090/v1/fs/copy", json={"src": "photos:/a.jpg", "dst": "nas:/b.jpg"}, headers=headers)`
    }
  },
  {
    id: 'jobs-query',
    category: '异步队列与运维',
    method: 'GET',
    path: '/v1/jobs/{job_id}',
    title: '查询异步作业执行进度',
    description: '轮询或检查跨后端流式拷贝、全量对账 (Reconcile) 作业的实时进度、传输速度与状态。',
    params: [
      { name: 'job_id', type: 'string', required: true, in: 'path', desc: '异步作业任务唯一ID' }
    ],
    response200: `{
  "code": 0,
  "data": {
    "id": "job-copy-8821",
    "type": "cross_mount_copy",
    "status": "running",
    "progress": 72.5,
    "current_bytes": 232355395,
    "total_bytes": 320490200,
    "speed": "45.2 MB/s"
  }
}`,
    codeSnippets: {
      curl: `curl -X GET "http://filestore.internal:8090/v1/jobs/job-copy-8821" \\
  -H "Authorization: Bearer $FILESTORE_TOKEN"`,
      go: `http.Get("http://filestore.internal:8090/v1/jobs/job-copy-8821")`,
      java: `restTemplate.getForObject("http://filestore.internal:8090/v1/jobs/job-copy-8821", JobStatus.class);`,
      python: `requests.get("http://filestore.internal:8090/v1/jobs/job-copy-8821", headers=headers)`
    }
  },
  {
    id: 'mounts-list',
    category: '挂载与拓扑',
    method: 'GET',
    path: '/v1/mounts',
    title: '获取系统所有存储挂载表',
    description: '查询当前 PostgreSQL mounts 表中的挂载点清单及其能力矩阵 (Driver.Caps)。',
    response200: `{
  "code": 0,
  "data": [
    {
      "id": "m-001",
      "name": "photos",
      "type": "s3",
      "status": "active",
      "caps": {
        "list": true,
        "mkdir": false,
        "copy": true,
        "move": true,
        "multipart": true,
        "presign": true,
        "directory": false
      }
    }
  ]
}`,
    codeSnippets: {
      curl: `curl -X GET "http://filestore.internal:8090/v1/mounts" \\
  -H "Authorization: Bearer $FILESTORE_TOKEN"`,
      go: `req, _ := http.NewRequest("GET", "http://filestore.internal:8090/v1/mounts", nil)
req.Header.Set("Authorization", "Bearer " + token)
resp, _ := http.DefaultClient.Do(req)`,
      java: `restTemplate.exchange("http://filestore.internal:8090/v1/mounts", HttpMethod.GET, new HttpEntity<>(headers), String.class);`,
      python: `requests.get("http://filestore.internal:8090/v1/mounts", headers={"Authorization": f"Bearer {token}"})`
    }
  }
];

export const ApiDocs: React.FC = () => {
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [selectedEndpointId, setSelectedEndpointId] = useState<string>('auth-login');
  const [searchDocQuery, setSearchDocQuery] = useState<string>('');
  const [selectedLang, setSelectedLang] = useState<'curl' | 'go' | 'java' | 'python'>('curl');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Sandbox simulation state
  const [sandboxParamP, setSandboxParamP] = useState<string>('photos:/2026/summit_keynote.mp4');
  const [sandboxOutput, setSandboxOutput] = useState<string | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);

  const categories = ['all', '认证鉴权', '文件目录操作', '数据读取与传输', '文件编排管理', '异步队列与运维', '挂载与拓扑'];

  const filteredEndpoints = API_ENDPOINTS.filter(ep => {
    const matchesCat = activeCategory === 'all' || ep.category === activeCategory;
    if (!matchesCat) return false;
    if (!searchDocQuery) return true;
    const q = searchDocQuery.toLowerCase();
    return (
      ep.title.toLowerCase().includes(q) ||
      ep.path.toLowerCase().includes(q) ||
      ep.method.toLowerCase().includes(q) ||
      ep.description.toLowerCase().includes(q)
    );
  });

  const selectedEndpoint = API_ENDPOINTS.find(ep => ep.id === selectedEndpointId) || API_ENDPOINTS[0];

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const runSandboxTest = () => {
    setIsSimulating(true);
    setTimeout(() => {
      setIsSimulating(false);
      if (selectedEndpoint.method === 'GET' && selectedEndpoint.path === '/v1/fs') {
        setSandboxOutput(`HTTP/1.1 307 Temporary Redirect
Location: https://prod-team-photos.s3.amazonaws.com/2026/summit_keynote.mp4?signature=mock307
X-VFS-Strategy: direct-presigned
X-VFS-Driver: s3

[客户端直连] 客户端将直接连接 AWS S3 完成传输，API网关零带宽损耗。`);
      } else if (selectedEndpoint.response200) {
        setSandboxOutput(`HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-VFS-Index-Source: postgresql-fs_nodes

${selectedEndpoint.response200}`);
      } else {
        setSandboxOutput(`HTTP/1.1 200 OK\n{"code": 0, "message": "success"}`);
      }
    }, 350);
  };

  const getMethodBadge = (method: string) => {
    switch (method) {
      case 'GET':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'POST':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'PUT':
        return 'bg-amber-50 text-amber-700 border-amber-200';
      case 'DELETE':
        return 'bg-rose-50 text-rose-700 border-rose-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  return (
    <div className="flex-1 overflow-hidden bg-white text-slate-800 flex flex-col font-sans">
      {/* Clean Top Banner */}
      <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/50 flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">业务系统 API 文档</h1>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-100 font-medium">
              OpenAPI v1
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            统一使用 <code className="font-mono text-indigo-600 bg-indigo-50/80 px-1 py-0.5 rounded">mount:path</code> 语法，大文件自动 307 直传卸载。
          </p>
        </div>

        {/* Base URL Pill */}
        <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-mono shadow-xs">
          <span className="text-slate-400 font-sans text-[11px]">基地址:</span>
          <span className="font-semibold text-slate-800">http://filestore-api.internal:8090/v1</span>
          <button
            onClick={() => handleCopy('http://filestore-api.internal:8090/v1', 'base')}
            className="text-slate-400 hover:text-slate-700 p-0.5"
            title="复制基地址"
          >
            {copiedId === 'base' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Main Two-Column Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Endpoints Directory */}
        <div className="w-72 bg-slate-50 border-r border-slate-200 flex flex-col shrink-0">
          {/* Search bar inside docs */}
          <div className="p-3 border-b border-slate-200 space-y-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="搜索接口..."
                value={searchDocQuery}
                onChange={e => setSearchDocQuery(e.target.value)}
                className="w-full bg-white border border-slate-250 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100"
              />
            </div>

            {/* Category pills */}
            <div className="flex gap-1 overflow-x-auto pb-1 text-[11px] font-sans no-scrollbar">
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`px-2 py-0.5 rounded-md shrink-0 transition-colors ${
                    activeCategory === cat
                      ? 'bg-indigo-600 text-white font-medium shadow-xs'
                      : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200'
                  }`}
                >
                  {cat === 'all' ? '全部' : cat}
                </button>
              ))}
            </div>
          </div>

          {/* List of endpoints */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredEndpoints.map(ep => {
              const isSelected = selectedEndpointId === ep.id;
              const badgeClass = getMethodBadge(ep.method);

              return (
                <div
                  key={ep.id}
                  onClick={() => {
                    setSelectedEndpointId(ep.id);
                    setSandboxOutput(null);
                  }}
                  className={`p-2.5 rounded-lg cursor-pointer transition-all border ${
                    isSelected
                      ? 'bg-white border-indigo-200 text-slate-900 shadow-xs ring-1 ring-indigo-500/10 font-medium'
                      : 'bg-transparent hover:bg-slate-100 border-transparent text-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={`text-[10px] font-mono font-bold px-1.5 py-0.2 rounded border ${badgeClass}`}>
                      {ep.method}
                    </span>
                    <span className="font-mono text-xs text-slate-800 truncate">{ep.path}</span>
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">{ep.title}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Detail & Code Generator Panel */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-4xl">
          {/* Endpoint Title */}
          <div>
            <div className="flex items-center gap-2.5 mb-1.5">
              <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded border ${getMethodBadge(selectedEndpoint.method)}`}>
                {selectedEndpoint.method}
              </span>
              <span className="text-base font-mono font-bold text-slate-900">{selectedEndpoint.path}</span>
            </div>
            <h2 className="text-sm font-semibold text-slate-800 mt-1">{selectedEndpoint.title}</h2>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">{selectedEndpoint.description}</p>
          </div>

          {/* Parameters Table */}
          {selectedEndpoint.params && selectedEndpoint.params.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-700">请求参数 (Parameters)</div>
              <div className="border border-slate-200 rounded-lg overflow-hidden font-mono text-xs">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px]">
                    <tr>
                      <th className="px-3 py-2 font-medium">参数名</th>
                      <th className="px-3 py-2 font-medium">位置</th>
                      <th className="px-3 py-2 font-medium">类型</th>
                      <th className="px-3 py-2 font-medium">必填</th>
                      <th className="px-3 py-2 font-medium font-sans">说明</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {selectedEndpoint.params.map((param, i) => (
                      <tr key={i} className="hover:bg-slate-50/50">
                        <td className="px-3 py-2 font-bold text-indigo-700">{param.name}</td>
                        <td className="px-3 py-2 text-slate-500">{param.in}</td>
                        <td className="px-3 py-2 text-slate-600">{param.type}</td>
                        <td className="px-3 py-2 font-sans">
                          {param.required ? (
                            <span className="text-rose-600 font-medium">是</span>
                          ) : (
                            <span className="text-slate-400">否</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-600 font-sans">{param.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Request Body if applicable */}
          {selectedEndpoint.requestBody && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-700">请求体 (Request Body)</div>
              <pre className="p-3 bg-slate-900 text-indigo-300 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed">
                {selectedEndpoint.requestBody}
              </pre>
            </div>
          )}

          {/* Multi-Language SDK Snippets Generator */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">调用代码示例 (Code Snippet)</span>
              <button
                onClick={() => handleCopy(selectedEndpoint.codeSnippets[selectedLang], 'snippet')}
                className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
              >
                {copiedId === 'snippet' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedId === 'snippet' ? '已复制' : '复制代码'}</span>
              </button>
            </div>

            {/* Language Tabs */}
            <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs font-medium w-fit">
              {(['curl', 'go', 'java', 'python'] as const).map(lang => (
                <button
                  key={lang}
                  onClick={() => setSelectedLang(lang)}
                  className={`px-3 py-1 rounded transition-colors ${
                    selectedLang === lang
                      ? 'bg-white text-slate-900 shadow-xs font-semibold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {lang === 'curl' ? 'cURL' : lang === 'go' ? 'Golang' : lang === 'java' ? 'Java' : 'Python'}
                </button>
              ))}
            </div>

            <pre className="p-3.5 bg-slate-900 text-emerald-400 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed">
              {selectedEndpoint.codeSnippets[selectedLang]}
            </pre>
          </div>

          {/* Response 200 */}
          <div className="space-y-2">
            <span className="text-xs font-semibold text-slate-700">响应示例 (HTTP 200 OK)</span>
            <pre className="p-3.5 bg-slate-900 text-slate-200 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed">
              {selectedEndpoint.response200 || '{"code": 0, "message": "success"}'}
            </pre>
          </div>

          {/* Interactive Sandbox Test Runner */}
          <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Play className="w-4 h-4 text-emerald-600" />
                <span className="font-semibold text-slate-900 text-xs">接口沙箱试调 (Sandbox Test)</span>
              </div>
              <button
                onClick={runSandboxTest}
                disabled={isSimulating}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-all disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{isSimulating ? '请求中...' : '发送测试'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 text-xs">
              <div>
                <label className="text-[11px] text-slate-500 block mb-1">测试参数 p (mount:path):</label>
                <input
                  type="text"
                  value={sandboxParamP}
                  onChange={e => setSandboxParamP(e.target.value)}
                  className="w-full bg-white border border-slate-250 rounded px-2.5 py-1 text-slate-800 font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="text-[11px] text-slate-500 block mb-1">Authorization Header:</label>
                <input
                  type="text"
                  readOnly
                  value="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                  className="w-full bg-slate-100 border border-slate-200 rounded px-2.5 py-1 text-slate-400 font-mono cursor-not-allowed"
                />
              </div>
            </div>

            {sandboxOutput && (
              <div className="pt-2">
                <span className="text-[11px] text-slate-500 block mb-1 font-medium">网关模拟响应:</span>
                <pre className="p-3 bg-slate-900 rounded-lg text-xs font-mono text-emerald-400 whitespace-pre-wrap leading-relaxed">
                  {sandboxOutput}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
