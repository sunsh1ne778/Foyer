import React, { useState } from 'react';
import {
  X,
  Copy,
  Check,
  Tag,
  Plus,
  Trash2,
  Terminal,
  Database,
  ExternalLink,
  Code,
  Download,
  FileText,
  Info
} from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';
import { formatBytes, formatDate } from '../utils/formatters';

export const FileStatDrawer: React.FC = () => {
  const { selectedNode, setSelectedNode, mounts, updateNodeOverlay } = useFileStore();

  const [activeTab, setActiveTab] = useState<'overview' | 'metadata' | 'code'>('overview');
  const [newTag, setNewTag] = useState('');
  const [newMetaKey, setNewMetaKey] = useState('');
  const [newMetaVal, setNewMetaVal] = useState('');
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [codeLang, setCodeLang] = useState<'cli' | 'curl' | 's3'>('cli');

  if (!selectedNode) return null;

  const mountObj = mounts.find(m => m.name === selectedNode.mount_name);
  const fullRef = `${selectedNode.mount_name}:${selectedNode.key}`;
  const isPresignMode = mountObj?.caps.presign;

  const handleCopy = (text: string, sectionKey: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(sectionKey);
    setTimeout(() => setCopiedSection(null), 1800);
  };

  const handleAddTag = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTag.trim()) return;
    const tag = newTag.trim();
    if (selectedNode.tags.includes(tag)) return;
    const updatedTags = [...selectedNode.tags, tag];
    updateNodeOverlay(selectedNode.mount_name, selectedNode.key, updatedTags, selectedNode.custom_meta);
    setNewTag('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    const updatedTags = selectedNode.tags.filter(t => t !== tagToRemove);
    updateNodeOverlay(selectedNode.mount_name, selectedNode.key, updatedTags, selectedNode.custom_meta);
  };

  const handleAddCustomMeta = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMetaKey.trim() || !newMetaVal.trim()) return;
    const updatedMeta = {
      ...selectedNode.custom_meta,
      [newMetaKey.trim()]: newMetaVal.trim()
    };
    updateNodeOverlay(selectedNode.mount_name, selectedNode.key, selectedNode.tags, updatedMeta);
    setNewMetaKey('');
    setNewMetaVal('');
  };

  const handleRemoveCustomMeta = (keyToRemove: string) => {
    const updatedMeta = { ...selectedNode.custom_meta };
    delete updatedMeta[keyToRemove];
    updateNodeOverlay(selectedNode.mount_name, selectedNode.key, selectedNode.tags, updatedMeta);
  };

  // Commands
  const cliCmd = selectedNode.is_dir
    ? `filestore ls "${fullRef}"`
    : `filestore get "${fullRef}" ./download/`;

  const curlCmd = selectedNode.is_dir
    ? `curl -X GET "http://localhost:8090/v1/fs/list?p=${encodeURIComponent(fullRef)}" \\\n  -H "Authorization: Bearer $FILESTORE_TOKEN"`
    : `curl -i -X GET "http://localhost:8090/v1/fs?p=${encodeURIComponent(fullRef)}" \\\n  -H "Authorization: Bearer $FILESTORE_TOKEN"`;

  const s3GatewayCmd = selectedNode.is_dir
    ? `mc ls mygateway/${selectedNode.mount_name}${selectedNode.key === '/' ? '' : selectedNode.key}/`
    : `mc cp mygateway/${selectedNode.mount_name}${selectedNode.key} ./`;

  return (
    <div className="w-88 sm:w-96 bg-white border-l border-slate-200 flex flex-col h-[calc(100vh-56px)] shrink-0 select-none z-20 shadow-lg overflow-hidden animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-indigo-600 shrink-0" />
          <span className="font-semibold text-sm text-slate-900 truncate" title={selectedNode.name}>
            {selectedNode.name}
          </span>
        </div>
        <button
          onClick={() => setSelectedNode(null)}
          className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white px-3 pt-2 text-xs font-medium text-slate-500 gap-2">
        <button
          onClick={() => setActiveTab('overview')}
          className={`pb-2 px-2 border-b-2 transition-colors ${
            activeTab === 'overview'
              ? 'border-indigo-600 text-indigo-600 font-semibold'
              : 'border-transparent hover:text-slate-800'
          }`}
        >
          属性概览
        </button>
        <button
          onClick={() => setActiveTab('metadata')}
          className={`pb-2 px-2 border-b-2 transition-colors ${
            activeTab === 'metadata'
              ? 'border-indigo-600 text-indigo-600 font-semibold'
              : 'border-transparent hover:text-slate-800'
          }`}
        >
          元数据 ({selectedNode.tags.length + Object.keys(selectedNode.custom_meta).length})
        </button>
        <button
          onClick={() => setActiveTab('code')}
          className={`pb-2 px-2 border-b-2 transition-colors ${
            activeTab === 'code'
              ? 'border-indigo-600 text-indigo-600 font-semibold'
              : 'border-transparent hover:text-slate-800'
          }`}
        >
          契约调用 (CLI)
        </button>
      </div>

      {/* Body Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs text-slate-700">
        {activeTab === 'overview' && (
          <div className="space-y-4">
            {/* Unified Ref Card */}
            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
              <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                <span>统一定位标识 (mount:path)</span>
                <button
                  onClick={() => handleCopy(fullRef, 'ref')}
                  className="text-indigo-600 hover:text-indigo-800 flex items-center gap-1 font-sans font-medium"
                >
                  {copiedSection === 'ref' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedSection === 'ref' ? '已复制' : '复制'}</span>
                </button>
              </div>
              <div className="text-slate-900 font-mono font-semibold break-all bg-white px-2.5 py-1.5 rounded border border-slate-250">
                {fullRef}
              </div>
            </div>

            {/* Properties Table */}
            <div className="border border-slate-200 rounded-lg overflow-hidden bg-white divide-y divide-slate-100 font-mono">
              <div className="flex items-center justify-between p-2.5">
                <span className="text-slate-500 font-sans">存储驱动</span>
                <span className="font-semibold text-slate-900 uppercase">{mountObj?.type}</span>
              </div>
              <div className="flex items-center justify-between p-2.5">
                <span className="text-slate-500 font-sans">对象类型</span>
                <span className="text-slate-800 font-sans">{selectedNode.is_dir ? '目录' : '普通文件'}</span>
              </div>
              <div className="flex items-center justify-between p-2.5">
                <span className="text-slate-500 font-sans">数据大小</span>
                <span className="text-slate-800">{formatBytes(selectedNode.size)}</span>
              </div>
              {selectedNode.etag && (
                <div className="flex items-center justify-between p-2.5">
                  <span className="text-slate-500 font-sans">ETag 散列</span>
                  <span className="text-slate-600 text-[11px] truncate max-w-[160px]" title={selectedNode.etag}>
                    {selectedNode.etag.replace(/"/g, '')}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between p-2.5">
                <span className="text-slate-500 font-sans">修改时间</span>
                <span className="text-slate-600 text-[11px]">{formatDate(selectedNode.mtime)}</span>
              </div>
            </div>

            {/* Transmission Strategy Card */}
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-slate-700">传输调度策略</span>
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-medium ${
                  isPresignMode ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'
                }`}>
                  {isPresignMode ? '307 直连重定向' : '200 流式代理'}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                {isPresignMode
                  ? '底层驱动支持预签名 URL，API 网关返回 307 重定向，客户端直连底层存储，零网关带宽消耗。'
                  : '底层为本地磁盘或不支持预签名的存储，网关进行流式代理分块中转。'}
              </p>
            </div>
          </div>
        )}

        {activeTab === 'metadata' && (
          <div className="space-y-4">
            {/* Tags Section */}
            <div>
              <div className="text-xs font-semibold text-slate-800 mb-2">业务标签 (Tags Overlay)</div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {selectedNode.tags.map((tag, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-slate-100 text-slate-700 border border-slate-200"
                  >
                    <span>{tag}</span>
                    <button
                      onClick={() => handleRemoveTag(tag)}
                      className="text-slate-400 hover:text-rose-600"
                    >
                      ✕
                    </button>
                  </span>
                ))}
                {selectedNode.tags.length === 0 && (
                  <span className="text-xs text-slate-400 italic">暂无标签</span>
                )}
              </div>
              <form onSubmit={handleAddTag} className="flex gap-2">
                <input
                  type="text"
                  placeholder="添加新标签..."
                  value={newTag}
                  onChange={e => setNewTag(e.target.value)}
                  className="flex-1 bg-white border border-slate-200 rounded px-2.5 py-1 text-xs text-slate-800 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="submit"
                  className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium transition-colors"
                >
                  添加
                </button>
              </form>
            </div>

            {/* Custom Metadata KV */}
            <div className="pt-2 border-t border-slate-200">
              <div className="text-xs font-semibold text-slate-800 mb-2">自定义属性 (Custom KV)</div>
              <div className="space-y-1.5 mb-3">
                {Object.entries(selectedNode.custom_meta).map(([k, v]) => (
                  <div
                    key={k}
                    className="flex items-center justify-between p-2 rounded bg-slate-50 border border-slate-200 text-xs font-mono"
                  >
                    <span className="text-indigo-600 font-semibold">{k}:</span>
                    <span className="text-slate-700 truncate max-w-[140px]">{String(v)}</span>
                    <button
                      onClick={() => handleRemoveCustomMeta(k)}
                      className="text-slate-400 hover:text-rose-600 p-0.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {Object.keys(selectedNode.custom_meta).length === 0 && (
                  <span className="text-xs text-slate-400 italic block">暂无扩展键值</span>
                )}
              </div>
              <form onSubmit={handleAddCustomMeta} className="flex gap-2">
                <input
                  type="text"
                  placeholder="键 (Key)"
                  value={newMetaKey}
                  onChange={e => setNewMetaKey(e.target.value)}
                  className="w-1/2 bg-white border border-slate-200 rounded px-2 py-1 text-xs text-slate-800 focus:outline-none focus:border-indigo-500 font-mono"
                />
                <input
                  type="text"
                  placeholder="值 (Value)"
                  value={newMetaVal}
                  onChange={e => setNewMetaVal(e.target.value)}
                  className="w-1/2 bg-white border border-slate-200 rounded px-2 py-1 text-xs text-slate-800 focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  type="submit"
                  className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium transition-colors shrink-0"
                >
                  添加
                </button>
              </form>
            </div>
          </div>
        )}

        {activeTab === 'code' && (
          <div className="space-y-3">
            <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs font-medium">
              <button
                onClick={() => setCodeLang('cli')}
                className={`flex-1 py-1 rounded ${codeLang === 'cli' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}
              >
                Cobra CLI
              </button>
              <button
                onClick={() => setCodeLang('curl')}
                className={`flex-1 py-1 rounded ${codeLang === 'curl' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}
              >
                REST cURL
              </button>
              <button
                onClick={() => setCodeLang('s3')}
                className={`flex-1 py-1 rounded ${codeLang === 's3' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}`}
              >
                S3 Gateway
              </button>
            </div>

            <div className="relative">
              <pre className="bg-slate-900 text-slate-200 p-3 rounded-lg text-xs font-mono overflow-x-auto leading-relaxed border border-slate-800">
                {codeLang === 'cli' && cliCmd}
                {codeLang === 'curl' && curlCmd}
                {codeLang === 's3' && s3GatewayCmd}
              </pre>
              <button
                onClick={() => {
                  const cmd = codeLang === 'cli' ? cliCmd : codeLang === 'curl' ? curlCmd : s3GatewayCmd;
                  handleCopy(cmd, 'cmd');
                }}
                className="absolute top-2 right-2 px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-sans flex items-center gap-1"
              >
                {copiedSection === 'cmd' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copiedSection === 'cmd' ? '已复制' : '复制'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
