import React, { createContext, useContext, useState, useEffect } from 'react';
import { Mount, FSNode, VFSJob, WriteSession, SystemClusterInfo, DriverType } from '../types';
import { INITIAL_MOUNTS, INITIAL_NODES, INITIAL_JOBS } from '../mockData';
import { parseRef } from '../utils/formatters';

interface FileStoreContextType {
  mounts: Mount[];
  nodes: FSNode[];
  jobs: VFSJob[];
  writeSessions: WriteSession[];
  clusterInfo: SystemClusterInfo;
  
  // Navigation
  currentMount: string;
  currentPath: string;
  currentRef: string;
  pathInput: string;
  setPathInput: (val: string) => void;
  navigateTo: (mount: string, path: string) => void;
  navigateToRef: (refStr: string) => void;
  navigateUp: () => void;

  // Views & Filters
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

  // Modals
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

  // Actions
  getCurrentMountObj: () => Mount | undefined;
  listCurrentNodes: () => FSNode[];
  createFolder: (name: string) => boolean;
  deleteNode: (key: string) => void;
  deleteBatch: (keys: string[]) => void;
  uploadFile: (file: File) => Promise<void>;
  executeCopyMove: (srcRef: string, dstRef: string, isMove: boolean) => void;
  addMount: (newMount: Omit<Mount, 'id' | 'created_at' | 'updated_at'>) => void;
  updateMountSpec: (id: string, spec: Record<string, string>) => void;
  removeMount: (id: string) => void;
  probeMount: (id: string) => Promise<boolean>;
  triggerReconcile: (mountName: string) => void;
  updateNodeOverlay: (mountName: string, key: string, tags: string[], custom: Record<string, string>) => void;
  cancelJob: (jobId: string) => void;
  retryJob: (jobId: string) => void;
  resetAllData: () => void;
}

const FileStoreContext = createContext<FileStoreContextType | null>(null);

export const FileStoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Persistence state
  const [mounts, setMounts] = useState<Mount[]>(() => {
    const saved = localStorage.getItem('fs_mounts');
    return saved ? JSON.parse(saved) : INITIAL_MOUNTS;
  });

  const [nodes, setNodes] = useState<FSNode[]>(() => {
    const saved = localStorage.getItem('fs_nodes');
    return saved ? JSON.parse(saved) : INITIAL_NODES;
  });

  const [jobs, setJobs] = useState<VFSJob[]>(() => {
    const saved = localStorage.getItem('fs_jobs');
    return saved ? JSON.parse(saved) : INITIAL_JOBS;
  });

  const [writeSessions, setWriteSessions] = useState<WriteSession[]>([]);

  // Navigation
  const [currentMount, setCurrentMount] = useState<string>('photos');
  const [currentPath, setCurrentPath] = useState<string>('/');
  const [pathInput, setPathInput] = useState<string>('photos:/');
  const [currentTab, setCurrentTab] = useState<'files' | 'mounts' | 'jobs' | 'cli' | 'docs'>('files');

  // UI state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');
  const [selectedNode, setSelectedNode] = useState<FSNode | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // Modals
  const [isUploadOpen, setIsUploadOpen] = useState<boolean>(false);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState<boolean>(false);
  const [isNewMountOpen, setIsNewMountOpen] = useState<boolean>(false);
  const [isCopyMoveOpen, setIsCopyMoveOpen] = useState<boolean>(false);
  const [copyMoveTarget, setCopyMoveTarget] = useState<FSNode | null>(null);
  const [isCopyMoveMoveMode, setIsCopyMoveMoveMode] = useState<boolean>(false);

  // Cluster telemetry
  const clusterInfo: SystemClusterInfo = {
    apiNodes: 3,
    workerNodes: 2,
    postgresStatus: 'healthy',
    redisStatus: 'healthy',
    activeSessions: writeSessions.length,
    indexCount: nodes.length
  };

  // Sync to localStorage
  useEffect(() => {
    localStorage.setItem('fs_mounts', JSON.stringify(mounts));
  }, [mounts]);

  useEffect(() => {
    localStorage.setItem('fs_nodes', JSON.stringify(nodes));
  }, [nodes]);

  useEffect(() => {
    localStorage.setItem('fs_jobs', JSON.stringify(jobs));
  }, [jobs]);

  // Derived current reference
  const currentRef = `${currentMount}:${currentPath}`;

  // Keep path input in sync
  useEffect(() => {
    setPathInput(`${currentMount}:${currentPath}`);
    setSelectedKeys(new Set());
  }, [currentMount, currentPath]);

  const navigateTo = (mount: string, path: string) => {
    const cleanPath = path.startsWith('/') ? path : '/' + path;
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
    const parentPath = parts.length === 0 ? '/' : '/' + parts.join('/');
    navigateTo(currentMount, parentPath);
  };

  const getCurrentMountObj = (): Mount | undefined => {
    return mounts.find(m => m.name === currentMount);
  };

  // List nodes in the current path according to the PG projection index logic
  const listCurrentNodes = (): FSNode[] => {
    const prefix = currentPath === '/' ? '/' : currentPath + '/';
    return nodes.filter(n => {
      if (n.mount_name !== currentMount) return false;
      if (currentPath === '/') {
        // Direct child of root: has only one slash (at the start) or is a dir right under root
        const sub = n.key.slice(1);
        return !sub.includes('/');
      } else {
        if (!n.key.startsWith(prefix)) return false;
        const sub = n.key.slice(prefix.length);
        return sub.length > 0 && !sub.includes('/');
      }
    });
  };

  const toggleSelectKey = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllKeys = (keys: string[]) => {
    setSelectedKeys(new Set(keys));
  };

  const clearSelection = () => {
    setSelectedKeys(new Set());
  };

  const createFolder = (name: string): boolean => {
    if (!name.trim()) return false;
    const cleanName = name.trim().replace(/[\\/:*?"<>|]/g, '_');
    const folderKey = currentPath === '/' ? `/${cleanName}` : `${currentPath}/${cleanName}`;

    // Check if exists
    const exists = nodes.some(n => n.mount_name === currentMount && n.key === folderKey);
    if (exists) return false;

    const currentMountObj = getCurrentMountObj();
    const newNode: FSNode = {
      mount_id: currentMountObj ? currentMountObj.id : 'm-custom',
      mount_name: currentMount,
      key: folderKey,
      name: cleanName,
      is_dir: true,
      size: 0,
      mtime: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      tags: [],
      custom_meta: {}
    };

    setNodes(prev => [...prev, newNode]);
    return true;
  };

  const deleteNode = (key: string) => {
    // Delete node and any nested children (if dir)
    setNodes(prev => prev.filter(n => {
      if (n.mount_name !== currentMount) return true;
      if (n.key === key) return false;
      if (n.key.startsWith(key + '/')) return false;
      return true;
    }));
    if (selectedNode?.key === key) {
      setSelectedNode(null);
    }
  };

  const deleteBatch = (keys: string[]) => {
    const keySet = new Set(keys);
    setNodes(prev => prev.filter(n => {
      if (n.mount_name !== currentMount) return true;
      if (keySet.has(n.key)) return false;
      for (const k of keys) {
        if (n.key.startsWith(k + '/')) return false;
      }
      return true;
    }));
    clearSelection();
  };

  // Upload file adhering to WriteBegin -> Mode decision -> Parts -> Complete
  const uploadFile = async (file: File): Promise<void> => {
    const mountObj = getCurrentMountObj();
    if (!mountObj) return;

    const isPresignMode = mountObj.caps.presign;
    const mode: 'redirect' | 'stream' = isPresignMode ? 'redirect' : 'stream';
    const sessionId = `wsess-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
    const fileKey = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
    const fileRef = `${currentMount}:${fileKey}`;

    const newSession: WriteSession = {
      id: sessionId,
      ref: fileRef,
      mode,
      filename: file.name,
      size: file.size,
      parts_total: Math.ceil(file.size / (5 * 1024 * 1024)) || 1,
      parts_completed: 0,
      created_at: new Date().toISOString(),
      status: 'uploading'
    };

    setWriteSessions(prev => [newSession, ...prev]);

    // Simulate multi-part progression
    const totalParts = newSession.parts_total;
    for (let i = 1; i <= totalParts; i++) {
      await new Promise(r => setTimeout(r, 200));
      setWriteSessions(prev => prev.map(s => s.id === sessionId ? { ...s, parts_completed: i } : s));
    }

    // Complete write & write-through to PG index
    setWriteSessions(prev => prev.map(s => s.id === sessionId ? { ...s, status: 'completed' } : s));

    const newNode: FSNode = {
      mount_id: mountObj.id,
      mount_name: currentMount,
      key: fileKey,
      name: file.name,
      is_dir: false,
      size: file.size,
      etag: `"${Math.random().toString(16).substring(2, 10)}${Math.random().toString(16).substring(2, 10)}"`,
      mtime: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      tags: ['新上传'],
      custom_meta: {
        write_mode: mode,
        session_id: sessionId
      }
    };

    setNodes(prev => {
      // Overwrite if same key exists
      const filtered = prev.filter(n => !(n.mount_name === currentMount && n.key === fileKey));
      return [...filtered, newNode];
    });

    // Update mount stats
    setMounts(prev => prev.map(m => {
      if (m.name === currentMount) {
        return {
          ...m,
          stats: {
            total_bytes: (m.stats?.total_bytes || 0) + file.size,
            node_count: (m.stats?.node_count || 0) + 1,
            last_reconciled: m.stats?.last_reconciled
          }
        };
      }
      return m;
    }));
  };

  // Copy or Move operation adhering to spec
  const executeCopyMove = (srcRef: string, dstRef: string, isMove: boolean) => {
    const srcParsed = parseRef(srcRef);
    const dstParsed = parseRef(dstRef);

    const srcMount = mounts.find(m => m.name === srcParsed.mount);
    const dstMount = mounts.find(m => m.name === dstParsed.mount);

    if (!srcMount || !dstMount) return;

    const isCrossMount = srcParsed.mount !== dstParsed.mount;
    const canNative = !isCrossMount && (isMove ? srcMount.caps.move : srcMount.caps.copy);

    if (canNative) {
      // Synchronous in-driver operation (Fast path)
      const srcNode = nodes.find(n => n.mount_name === srcParsed.mount && n.key === srcParsed.path);
      if (!srcNode) return;

      const dstFileName = dstParsed.path.split('/').pop() || srcNode.name;
      const copiedNode: FSNode = {
        ...srcNode,
        mount_id: dstMount.id,
        mount_name: dstMount.name,
        key: dstParsed.path,
        name: dstFileName,
        updated_at: new Date().toISOString()
      };

      setNodes(prev => {
        let list = prev;
        if (isMove) {
          list = list.filter(n => !(n.mount_name === srcParsed.mount && n.key === srcParsed.path));
        }
        return [...list.filter(n => !(n.mount_name === dstParsed.mount && n.key === dstParsed.path)), copiedNode];
      });
    } else {
      // Cross-mount or non-capable driver -> Dispatches to Asynq worker (HTTP 202 + job_id)
      const jobId = `job-${isMove ? 'move' : 'copy'}-${Date.now().toString(36)}`;
      const newJob: VFSJob = {
        id: jobId,
        type: isMove ? 'move_async' : 'copy_async',
        src_ref: srcRef,
        dst_ref: dstRef,
        status: 'running',
        progress: 10,
        speed: '35 MB/s',
        message: `跨挂载流式传输已交由 Asynq Worker 执行 (${srcMount.type} ➔ ${dstMount.type})`,
        started_at: new Date().toISOString()
      };

      setJobs(prev => [newJob, ...prev]);

      // Simulate worker progress in background
      let progress = 10;
      const interval = setInterval(() => {
        progress += 25;
        if (progress >= 100) {
          clearInterval(interval);
          setJobs(prev => prev.map(j => j.id === jobId ? {
            ...j,
            status: 'completed',
            progress: 100,
            message: '跨存储复制完成，目标索引已写入 PG fs_nodes',
            completed_at: new Date().toISOString()
          } : j));

          // Write node to destination
          const srcNode = nodes.find(n => n.mount_name === srcParsed.mount && n.key === srcParsed.path);
          if (srcNode) {
            const dstFileName = dstParsed.path.split('/').pop() || srcNode.name;
            const copiedNode: FSNode = {
              ...srcNode,
              mount_id: dstMount.id,
              mount_name: dstMount.name,
              key: dstParsed.path,
              name: dstFileName,
              updated_at: new Date().toISOString()
            };
            setNodes(prev => {
              let list = prev;
              if (isMove) {
                list = list.filter(n => !(n.mount_name === srcParsed.mount && n.key === srcParsed.path));
              }
              return [...list.filter(n => !(n.mount_name === dstParsed.mount && n.key === dstParsed.path)), copiedNode];
            });
          }
        } else {
          setJobs(prev => prev.map(j => j.id === jobId ? { ...j, progress } : j));
        }
      }, 600);
    }
  };

  const addMount = (newMountData: Omit<Mount, 'id' | 'created_at' | 'updated_at'>) => {
    const id = `m-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const newMount: Mount = {
      ...newMountData,
      id,
      created_at: now,
      updated_at: now,
      stats: {
        total_bytes: 0,
        node_count: 0,
        last_reconciled: '尚未对账'
      }
    };
    setMounts(prev => [...prev, newMount]);
    // Automatically trigger initial reconcile
    triggerReconcile(newMount.name);
  };

  const updateMountSpec = (id: string, spec: Record<string, string>) => {
    setMounts(prev => prev.map(m => m.id === id ? { ...m, spec, updated_at: new Date().toISOString() } : m));
  };

  const removeMount = (id: string) => {
    const mount = mounts.find(m => m.id === id);
    if (!mount) return;
    setMounts(prev => prev.filter(m => m.id !== id));
    setNodes(prev => prev.filter(n => n.mount_name !== mount.name));
    if (currentMount === mount.name) {
      const remaining = mounts.filter(m => m.id !== id);
      if (remaining.length > 0) {
        setCurrentMount(remaining[0].name);
        setCurrentPath('/');
      }
    }
  };

  const probeMount = async (id: string): Promise<boolean> => {
    await new Promise(r => setTimeout(r, 600));
    setMounts(prev => prev.map(m => m.id === id ? { ...m, status: 'active', last_error: '' } : m));
    return true;
  };

  const triggerReconcile = (mountName: string) => {
    const jobId = `job-recon-${Date.now().toString(36)}`;
    const newJob: VFSJob = {
      id: jobId,
      type: 'reconcile',
      mount_name: mountName,
      status: 'running',
      progress: 15,
      speed: '520 nodes/s',
      message: `对账作业已启动：Driver.List 遍历底层对象并批量更新 PG fs_nodes 投影索引...`,
      started_at: new Date().toISOString()
    };

    setJobs(prev => [newJob, ...prev]);
    setMounts(prev => prev.map(m => m.name === mountName ? { ...m, status: 'reconciling' } : m));

    let prog = 15;
    const interval = setInterval(() => {
      prog += 30;
      if (prog >= 100) {
        clearInterval(interval);
        setJobs(prev => prev.map(j => j.id === jobId ? {
          ...j,
          status: 'completed',
          progress: 100,
          message: '对账完成，索引与原生底层存储严格一致',
          completed_at: new Date().toISOString()
        } : j));
        setMounts(prev => prev.map(m => m.name === mountName ? {
          ...m,
          status: 'active',
          stats: {
            ...m.stats,
            total_bytes: m.stats?.total_bytes || 1024000,
            node_count: m.stats?.node_count || 12,
            last_reconciled: new Date().toISOString()
          }
        } : m));
      } else {
        setJobs(prev => prev.map(j => j.id === jobId ? { ...j, progress: prog } : j));
      }
    }, 500);
  };

  const updateNodeOverlay = (mountName: string, key: string, tags: string[], custom: Record<string, string>) => {
    setNodes(prev => prev.map(n => {
      if (n.mount_name === mountName && n.key === key) {
        return {
          ...n,
          tags,
          custom_meta: custom,
          updated_at: new Date().toISOString()
        };
      }
      return n;
    }));
    if (selectedNode && selectedNode.mount_name === mountName && selectedNode.key === key) {
      setSelectedNode({
        ...selectedNode,
        tags,
        custom_meta: custom,
        updated_at: new Date().toISOString()
      });
    }
  };

  const cancelJob = (jobId: string) => {
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'failed', message: '操作已由控制台终止' } : j));
  };

  const retryJob = (jobId: string) => {
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'running', progress: 10, message: '重新加入 Asynq 队列重试' } : j));
  };

  const resetAllData = () => {
    localStorage.removeItem('fs_mounts');
    localStorage.removeItem('fs_nodes');
    localStorage.removeItem('fs_jobs');
    setMounts(INITIAL_MOUNTS);
    setNodes(INITIAL_NODES);
    setJobs(INITIAL_JOBS);
    setCurrentMount('photos');
    setCurrentPath('/');
    setSelectedNode(null);
  };

  return (
    <FileStoreContext.Provider
      value={{
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
        updateNodeOverlay,
        cancelJob,
        retryJob,
        resetAllData
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
