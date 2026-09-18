import React from 'react';
import { FileStoreProvider, useFileStore } from './context/FileStoreContext';
import { LoginScreen } from './components/LoginScreen';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { FileExplorer } from './components/FileExplorer';
import { FileStatDrawer } from './components/FileStatDrawer';
import { MountManager } from './components/MountManager';
import { JobMonitor } from './components/JobMonitor';
import { CliPlaybook } from './components/CliPlaybook';
import { ApiDocs } from './components/ApiDocs';
import { UploadModal } from './components/UploadModal';
import { NewMountModal } from './components/NewMountModal';
import { NewFolderModal } from './components/NewFolderModal';
import { CopyMoveModal } from './components/CopyMoveModal';

const MainLayout: React.FC = () => {
  const { currentTab, selectedNode, apiError, clearApiError } = useFileStore();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans antialiased">
      {apiError && (
        <div className="bg-rose-50 border-b border-rose-100 px-4 py-2 text-xs text-rose-800 flex items-center justify-between gap-2">
          <span>{apiError}</span>
          <button type="button" onClick={clearApiError} className="text-rose-600 hover:underline shrink-0">
            关闭
          </button>
        </div>
      )}
      <Header />

      <div className="flex-1 flex overflow-hidden">
        {(currentTab === 'files' || currentTab === 'mounts') && <Sidebar />}

        <main className="flex-1 flex overflow-hidden relative">
          {currentTab === 'files' && (
            <>
              <FileExplorer />
              {selectedNode && <FileStatDrawer />}
            </>
          )}

          {currentTab === 'mounts' && <MountManager />}
          {currentTab === 'jobs' && <JobMonitor />}
          {currentTab === 'cli' && <CliPlaybook />}
          {currentTab === 'docs' && <ApiDocs />}
        </main>
      </div>

      <UploadModal />
      <NewMountModal />
      <NewFolderModal />
      <CopyMoveModal />
    </div>
  );
};

const AppGate: React.FC = () => {
  const { isAuthenticated, authBootstrapping } = useFileStore();

  if (authBootstrapping) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 text-slate-500 text-sm">
        正在连接 FileStore API…
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  return <MainLayout />;
};

export default function App() {
  return (
    <FileStoreProvider>
      <AppGate />
    </FileStoreProvider>
  );
}
