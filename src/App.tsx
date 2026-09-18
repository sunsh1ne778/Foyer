import React from 'react';
import { FileStoreProvider, useFileStore } from './context/FileStoreContext';
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
  const { currentTab, selectedNode } = useFileStore();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans antialiased">
      <Header />

      <div className="flex-1 flex overflow-hidden">
        {/* Storage Mount Navigator Sidebar (only show in files or mounts tab for maximum screen focus) */}
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

      {/* Global Action Modals */}
      <UploadModal />
      <NewMountModal />
      <NewFolderModal />
      <CopyMoveModal />
    </div>
  );
};

export default function App() {
  return (
    <FileStoreProvider>
      <MainLayout />
    </FileStoreProvider>
  );
}
