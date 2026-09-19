import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import * as api from '../api/client';
import type { FoyerImportResult } from '../api/jfs';
import { mapJob, mapListEntry, mapMount } from '../api/mappers';
import {
  Mount,
  FSNode,
  VFSJob,
  WriteSession,
  SystemClusterInfo,
  JobType,
} from '../types';
import { parseRef } from '../utils/formatters';

interface FileStoreContextType {
  isAuthenticated: boolean;
  authBootstrapping: boolean;
  authError: string;
  username: string;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  apiError: string | null;
  clearApiError: () => void;
  isLoadingDirectory: boolean;

  mounts: Mount[];
  nodes: FSNode[];
  jobs: VFSJob[];
  writeSessions: WriteSession[];
  clusterInfo: SystemClusterInfo;

  currentMount: string;
  currentPath: string;
  currentRef: string;
  pathInput: string;
  setPathInput: (val: string) => void;
  navigateTo: (mount: string, path: string) => void;
  navigateToRef: (refStr: string) => void;
  navigateUp: () => void;
  refreshMounts: () => Promise<void>;
  refreshDirectory: () => Promise<void>;
  downloadNode: (node: FSNode) => Promise<void>;

  currentTab: 'files' | 'mounts' | 'jobs' | 'cli' | 'docs';
  setCurrentTab: (tab: 'files' | 'mounts' | 'jobs' | 'cli' | 'docs') => void;
  searchQuery: string;
  setSearchQuery: (val: string) => void;
  viewMode: 'table' | 'grid';
  setViewMode: (val: 'table' | 'grid') => void;
  selectedNode: FSNode | null;
  setSelectedNode: (node: FSNode | null) => void;
  selectedKeys: Set<string>;
  toggleSelectKey: (key: string) => void;
  selectAllKeys: (keys: string[]) => void;
  clearSelection: () => void;

  isUploadOpen: boolean;
  setIsUploadOpen: (open: boolean) => void;
  isNewFolderOpen: boolean;
  setIsNewFolderOpen: (open: boolean) => void;
  isNewMountOpen: boolean;
  setIsNewMountOpen: (open: boolean) => void;
  isCopyMoveOpen: boolean;
  setIsCopyMoveOpen: (open: boolean) => void;
  copyMoveTarget: FSNode | null;
  setCopyMoveTarget: (node: FSNode | null) => void;
  isCopyMoveMoveMode: boolean;
  setIsCopyMoveMoveMode: (val: boolean) => void;

  getCurrentMountObj: () => Mount | undefined;
  listCurrentNodes: () => FSNode[];
  createFolder: (name: string) => Promise<boolean>;
  deleteNode: (key: string) => Promise<void>;
  deleteBatch: (keys: string[]) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  executeCopyMove: (srcRef: string, dstRef: string, isMove: boolean) => Promise<void>;
  addMount: (body: { name: string; type: Mount['type']; spec: Record<string, string> }) => Promise<void>;
  updateMountSpec: (id: string, spec: Record<string, string>) => Promise<void>;
  removeMount: (id: string) => Promise<void>;
  probeMount: (id: string) => Promise<boolean>;
  triggerReconcile: (mountName: string) => Promise<void>;
  previewLocalImport: (name: string, root: string) => Promise<FoyerImportResult>;
  resyncMount: (id: string) => Promise<FoyerImportResult>;
  updateNodeOverlay: (mountName: string, key: string, tags: string[], custom: Record<string, string>) => void;
  cancelJob: (jobId: string) => void;
  retryJob: (jobId: string) => void;
}

const FileStoreContext = createContext<FileStoreContextType | null>(null);

export const FileStoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authBootstrapping, setAuthBootstrapping] = useState(true);
  const [authError, setAuthError] = useState('');
  const [username, setUsername] = useState(api.storedUser());
  const [apiError, setApiError] = useState<string | null>(null);
  const [isLoadingDirectory, setIsLoadingDirectory] = useState(false);

  const [mounts, setMounts] = useState<Mount[]>([]);
  const [nodes, setNodes] = useState<FSNode[]>([]);
  const [jobs, setJobs] = useState<VFSJob[]>([]);
  const [writeSessions, setWriteSessions] = useState<WriteSession[]>([]);
  const [clusterInfo, setClusterInfo] = useState<SystemClusterInfo>({
    apiNodes: 1,
    workerNodes: 0,
    postgresStatus: 'degraded',
    redisStatus: 'degraded',
    activeSessions: 0,
    indexCount: 0,
  });

  const [currentMount, setCurrentMount] = useState<string>('');
  const [currentPath, setCurrentPath] = useState<string>('/');
  const [pathInput, setPathInput] = useState<string>('');
  const [currentTab, setCurrentTab] = useState<'files' | 'mounts' | 'jobs' | 'cli' | 'docs'>('files');

  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');
  const [selectedNode, setSelectedNode] = useState<FSNode | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);
  const [isNewMountOpen, setIsNewMountOpen] = useState(false);
  const [isCopyMoveOpen, setIsCopyMoveOpen] = useState(false);
  const [copyMoveTarget, setCopyMoveTarget] = useState<FSNode | null>(null);
  const [isCopyMoveMoveMode, setIsCopyMoveMoveMode] = useState(false);

  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const mountsRef = useRef(mounts);
  mountsRef.current = mounts;

  const clearApiError = () => setApiError(null);

  const reportError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    setApiError(msg);
  };

  const refreshHealth = useCallback(async () => {
    try {
      const h = await api.health();
      setClusterInfo(prev => ({
        ...prev,
        postgresStatus: h.ok ? 'healthy' : 'degraded',
        redisStatus: h.ok ? 'healthy' : 'degraded',
        activeSessions: writeSessions.length,
        indexCount: nodes.length,
      }));
    } catch {
      setClusterInfo(prev => ({
        ...prev,
        postgresStatus: 'degraded',
        redisStatus: 'degraded',
      }));
    }
  }, [nodes.length, writeSessions.length]);

  const refreshMounts = useCallback(async () => {
    const data = await api.listMounts();
    const list = (data.mounts || []).map(mapMount);
    setMounts(list);
    setCurrentMount(prev => {
      if (list.length === 0) return '';
      if (list.some(m => m.name === prev)) return prev;
      return list[0].name;
    });
  }, []);

  const refreshDirectory = useCallback(async () => {
    const mountName = currentMount;
    if (!mountName) {
      setNodes([]);
      return;
    }
    const mountObj = mountsRef.current.find(m => m.name === mountName);
    if (!mountObj) return;

    setIsLoadingDirectory(true);
    try {
      const p = api.joinRef(mountName, currentPath);
      const data = await api.listFiles(p);
      const entries = (data.entries || []).map(e => mapListEntry(e, mountObj));
      setNodes(entries);
      setSelectedNode(prev => {
        if (!prev) return null;
        const hit = entries.find(n => n.key === prev.key);
        return hit || null;
      });
    } catch (err) {
      reportError(err);
    } finally {
      setIsLoadingDirectory(false);
    }
  }, [currentMount, currentPath]);

  const startJobPoll = useCallback(
    (jobId: string, seed?: Partial<VFSJob>) => {
      setJobs(prev => {
        if (prev.some(j => j.id === jobId)) return prev;
        return [
          {
            id: jobId,
            type: seed?.type || 'copy_async',
            mount_name: seed?.mount_name,
            src_ref: seed?.src_ref,
            dst_ref: seed?.dst_ref,
            status: 'running',
            progress: 15,
            message: seed?.message || '任务执行中…',
            started_at: new Date().toISOString(),
          },
          ...prev,
        ];
      });

      if (pollTimers.current.has(jobId)) return;

      const tick = async () => {
        try {
          const raw = await api.getJob(jobId);
          const mountName = mountsRef.current.find(m => m.id === raw.mount_id)?.name;
          const mapped = mapJob(raw, mountName);
          setJobs(prev => prev.map(j => (j.id === jobId ? mapped : j)));
          if (mapped.status === 'completed' || mapped.status === 'failed') {
            const t = pollTimers.current.get(jobId);
            if (t) clearInterval(t);
            pollTimers.current.delete(jobId);
            if (mapped.status === 'completed') {
              void refreshDirectory();
              void refreshMounts();
            }
          }
        } catch {
          /* keep polling */
        }
      };

      void tick();
      const handle = setInterval(tick, 2000);
      pollTimers.current.set(jobId, handle);
    },
    [refreshDirectory, refreshMounts]
  );

  useEffect(() => {
    return () => {
      pollTimers.current.forEach(t => clearInterval(t));
      pollTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    (async () => {
      if (!api.hasToken()) {
        setAuthBootstrapping(false);
        return;
      }
      try {
        await api.listMounts();
        setUsername(api.storedUser());
        setIsAuthenticated(true);
      } catch {
        api.logout();
      } finally {
        setAuthBootstrapping(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    void refreshMounts().catch(reportError);
    void refreshHealth();
  }, [isAuthenticated, refreshMounts, refreshHealth]);

  useEffect(() => {
    if (!isAuthenticated || !currentMount) return;
    void refreshDirectory();
  }, [isAuthenticated, currentMount, currentPath, refreshDirectory]);

  useEffect(() => {
    setPathInput(currentMount ? `${currentMount}:${currentPath}` : '');
    setSelectedKeys(new Set());
  }, [currentMount, currentPath]);

  const currentRef = currentMount ? `${currentMount}:${currentPath}` : '';

  const login = async (user: string, pass: string) => {
    setAuthError('');
    await api.login(user, pass);
    setUsername(api.storedUser());
    setIsAuthenticated(true);
    await refreshMounts();
    await refreshHealth();
  };

  const logout = () => {
    api.logout();
    setIsAuthenticated(false);
    setMounts([]);
    setNodes([]);
    setJobs([]);
    setWriteSessions([]);
    setCurrentMount('');
    setSelectedNode(null);
    pollTimers.current.forEach(t => clearInterval(t));
    pollTimers.current.clear();
  };

  const navigateTo = (mount: string, path: string) => {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const normalized = cleanPath === '' ? '/' : cleanPath;
    setCurrentMount(mount);
    setCurrentPath(normalized);
    setSelectedNode(null);
  };

  const navigateToRef = (refStr: string) => {
    const parsed = parseRef(refStr);
    navigateTo(parsed.mount, parsed.path);
  };

  const navigateUp = () => {
    if (currentPath === '/') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = parts.length === 0 ? '/' : `/${parts.join('/')}`;
    navigateTo(currentMount, parentPath);
  };

  const getCurrentMountObj = (): Mount | undefined => mounts.find(m => m.name === currentMount);

  const listCurrentNodes = (): FSNode[] => nodes;

  const toggleSelectKey = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllKeys = (keys: string[]) => setSelectedKeys(new Set(keys));
  const clearSelection = () => setSelectedKeys(new Set());

  const createFolder = async (name: string): Promise<boolean> => {
    if (!name.trim() || !currentMount) return false;
    const cleanName = name.trim().replace(/[\\/:*?"<>|]/g, '_');
    const folderKey = currentPath === '/' ? `/${cleanName}` : `${currentPath}/${cleanName}`;
    try {
      await api.mkdir(api.joinRef(currentMount, folderKey));
      await refreshDirectory();
      return true;
    } catch (err) {
      reportError(err);
      return false;
    }
  };

  const deleteNode = async (key: string) => {
    if (!currentMount) return;
    try {
      await api.deletePath(api.joinRef(currentMount, key));
      if (selectedNode?.key === key) setSelectedNode(null);
      await refreshDirectory();
    } catch (err) {
      reportError(err);
    }
  };

  const deleteBatch = async (keys: string[]) => {
    for (const key of keys) {
      try {
        await api.deletePath(api.joinRef(currentMount, key));
      } catch (err) {
        reportError(err);
      }
    }
    clearSelection();
    await refreshDirectory();
  };

  const uploadFile = async (file: File): Promise<void> => {
    const mountObj = getCurrentMountObj();
    if (!mountObj || !currentMount) return;

    const fileKey = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
    const dest = api.joinRef(currentMount, fileKey);
    const mode = mountObj.caps.presign ? 'redirect' : 'stream';
    const sessionId = `ws-${Date.now().toString(36)}`;

    const newSession: WriteSession = {
      id: sessionId,
      ref: dest,
      mode,
      filename: file.name,
      size: file.size,
      parts_total: 1,
      parts_completed: 0,
      created_at: new Date().toISOString(),
      status: 'uploading',
    };
    setWriteSessions(prev => [newSession, ...prev]);

    try {
      await api.uploadFile(file, dest, ratio => {
        setWriteSessions(prev =>
          prev.map(s =>
            s.id === sessionId
              ? {
                  ...s,
                  parts_completed: Math.max(1, Math.round(ratio * (s.parts_total || 1))),
                  parts_total: s.parts_total || 1,
                }
              : s
          )
        );
      });
      setWriteSessions(prev =>
        prev.map(s => (s.id === sessionId ? { ...s, status: 'completed', parts_completed: s.parts_total } : s))
      );
      await refreshDirectory();
    } catch (err) {
      setWriteSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, status: 'aborted' } : s)));
      reportError(err);
      throw err;
    }
  };

  const executeCopyMove = async (srcRef: string, dstRef: string, isMove: boolean) => {
    try {
      const res = isMove
        ? await api.movePath(srcRef, dstRef, true)
        : await api.copyPath(srcRef, dstRef, true);
      if (res.job_id) {
        startJobPoll(res.job_id, {
          type: (isMove ? 'move_async' : 'copy_async') as JobType,
          src_ref: srcRef,
          dst_ref: dstRef,
          message: isMove ? '跨挂载移动任务已提交' : '复制任务已提交',
        });
      } else {
        await refreshDirectory();
      }
    } catch (err) {
      reportError(err);
    }
  };

  const addMount = async (body: { name: string; type: Mount['type']; spec: Record<string, string> }) => {
    const created = await api.createMount(body);
    await refreshMounts();
    navigateTo(created.name, '/');
  };

  const updateMountSpec = async (id: string, spec: Record<string, string>) => {
    await api.patchMount(id, { spec });
    await refreshMounts();
  };

  const removeMount = async (id: string) => {
    const mount = mounts.find(m => m.id === id);
    await api.deleteMount(id);
    await refreshMounts();
    if (mount && currentMount === mount.name) {
      const remaining = mounts.filter(m => m.id !== id);
      if (remaining.length > 0) navigateTo(remaining[0].name, '/');
      else setCurrentMount('');
    }
  };

  const probeMount = async (id: string): Promise<boolean> => {
    try {
      await api.probeMount(id);
      await refreshMounts();
      return true;
    } catch (err) {
      reportError(err);
      return false;
    }
  };

  const triggerReconcile = async (mountName: string) => {
    const m = mounts.find(x => x.name === mountName);
    if (!m) return;
    try {
      setMounts(prev => prev.map(x => (x.id === m.id ? { ...x, status: 'reconciling' } : x)));
      const res = await api.reconcileMount(m.id);
      if (res.job_id) {
        startJobPoll(res.job_id, {
          type: 'reconcile',
          mount_name: mountName,
          message: `挂载 ${mountName} 对账任务已提交`,
        });
      }
      await refreshMounts();
      await refreshDirectory();
    } catch (err) {
      reportError(err);
      await refreshMounts();
    }
  };

  const previewLocalImport = async (name: string, root: string) => {
    return api.previewLocalImport(name, root);
  };

  const resyncMount = async (id: string) => {
    try {
      const res = await api.resyncMount(id);
      await refreshMounts();
      await refreshDirectory();
      return res;
    } catch (err) {
      reportError(err);
      throw err;
    }
  };

  const downloadNode = async (node: FSNode) => {
    if (node.is_dir) return;
    const p = api.joinRef(node.mount_name, node.key);
    try {
      await api.downloadFile(p, node.name);
    } catch (err) {
      reportError(err);
    }
  };

  const updateNodeOverlay = (mountName: string, key: string, tags: string[], custom: Record<string, string>) => {
    setNodes(prev =>
      prev.map(n => (n.mount_name === mountName && n.key === key ? { ...n, tags, custom_meta: custom } : n))
    );
    if (selectedNode && selectedNode.mount_name === mountName && selectedNode.key === key) {
      setSelectedNode({ ...selectedNode, tags, custom_meta: custom });
    }
  };

  const cancelJob = (jobId: string) => {
    setJobs(prev => prev.map(j => (j.id === jobId ? { ...j, status: 'failed', message: '已在控制台标记取消' } : j)));
  };

  const retryJob = (jobId: string) => {
    startJobPoll(jobId, { message: '重新轮询任务状态' });
  };

  return (
    <FileStoreContext.Provider
      value={{
        isAuthenticated,
        authBootstrapping,
        authError,
        username,
        login,
        logout,
        apiError,
        clearApiError,
        isLoadingDirectory,
        mounts,
        nodes,
        jobs,
        writeSessions,
        clusterInfo,
        currentMount,
        currentPath,
        currentRef,
        pathInput,
        setPathInput,
        navigateTo,
        navigateToRef,
        navigateUp,
        refreshMounts,
        refreshDirectory,
        downloadNode,
        currentTab,
        setCurrentTab,
        searchQuery,
        setSearchQuery,
        viewMode,
        setViewMode,
        selectedNode,
        setSelectedNode,
        selectedKeys,
        toggleSelectKey,
        selectAllKeys,
        clearSelection,
        isUploadOpen,
        setIsUploadOpen,
        isNewFolderOpen,
        setIsNewFolderOpen,
        isNewMountOpen,
        setIsNewMountOpen,
        isCopyMoveOpen,
        setIsCopyMoveOpen,
        copyMoveTarget,
        setCopyMoveTarget,
        isCopyMoveMoveMode,
        setIsCopyMoveMoveMode,
        getCurrentMountObj,
        listCurrentNodes,
        createFolder,
        deleteNode,
        deleteBatch,
        uploadFile,
        executeCopyMove,
        addMount,
        updateMountSpec,
        removeMount,
        probeMount,
        triggerReconcile,
        previewLocalImport,
        resyncMount,
        updateNodeOverlay,
        cancelJob,
        retryJob,
      }}
    >
      {children}
    </FileStoreContext.Provider>
  );
};

export const useFileStore = (): FileStoreContextType => {
  const context = useContext(FileStoreContext);
  if (!context) {
    throw new Error('useFileStore must be used within a FileStoreProvider');
  }
  return context;
};
