import { useEffect, useState, useRef, useCallback } from "react";
import { api, type AgentSession } from "../lib/api";
import { IconZap, IconFolderOpen, IconX } from "./Icons";
import { useVisibleInterval } from "../lib/useVisibleInterval";

interface WorkspaceManagerProps {
  currentWorkspace: string;
  onSwitchWorkspace: (workspace: string) => void;
}

interface WorkspaceGroup {
  workspace: string;
  sessions: AgentSession[];
}

/**
 * Shows a badge/indicator when there are running agents in any workspace.
 * Clicking opens a dropdown to see all running sessions and optionally
 * switch workspaces or abort sessions.
 */
export function WorkspaceManager({ currentWorkspace, onSwitchWorkspace }: WorkspaceManagerProps) {
  const [runningSessions, setRunningSessions] = useState<AgentSession[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Poll for running sessions — slowed from 3s→5s and paused when the tab
  // is hidden so it doesn't cause a thundering herd of API calls (and React
  // commits) the moment the user comes back to the window.
  const fetchRunningSessions = useCallback(async () => {
    try {
      const { running } = await api.getAllRunningSessions();
      setRunningSessions(running);
    } catch (err) {
      console.warn("[WorkspaceManager] Failed to fetch running sessions:", err);
    }
  }, []);

  useVisibleInterval(() => { void fetchRunningSessions(); }, 5000, true, true);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  // Group sessions by workspace
  const workspaceGroups: WorkspaceGroup[] = [];
  const workspaceMap = new Map<string, AgentSession[]>();
  
  for (const session of runningSessions) {
    const ws = session.workspace || "Unknown";
    if (!workspaceMap.has(ws)) {
      workspaceMap.set(ws, []);
    }
    workspaceMap.get(ws)!.push(session);
  }
  
  for (const [workspace, sessions] of workspaceMap) {
    workspaceGroups.push({ workspace, sessions });
  }
  
  // Sort: current workspace first, then alphabetically
  workspaceGroups.sort((a, b) => {
    if (a.workspace === currentWorkspace) return -1;
    if (b.workspace === currentWorkspace) return 1;
    return a.workspace.localeCompare(b.workspace);
  });

  // Count sessions in other workspaces
  const otherWorkspaceCount = runningSessions.filter(s => s.workspace !== currentWorkspace).length;
  const totalCount = runningSessions.length;

  // Always show the badge - shows "0" when no agents running
  // (Previously returned null here, making it invisible)

  const handleAbort = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.abortSession(sessionId);
      // Refresh the list
      fetchRunningSessions();
    } catch (err) {
      console.error("[WorkspaceManager] Failed to abort session:", err);
    }
  };

  const formatDuration = (startTime: number) => {
    const seconds = Math.floor((Date.now() - startTime) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  };

  const getWorkspaceName = (fullPath: string) => {
    return fullPath.split("/").pop() || fullPath;
  };

  return (
    <div className={`workspace-manager ${isOpen ? "workspace-manager--open" : ""}`} ref={dropdownRef}>
      <button
        type="button"
        tabIndex={-1}
        className={`workspace-manager-badge ${totalCount === 0 ? "idle" : ""} ${otherWorkspaceCount > 0 ? "has-other" : ""}`}
        onClick={() => setIsOpen(!isOpen)}
        title={totalCount === 0 
          ? "No running agents" 
          : `${totalCount} running agent${totalCount !== 1 ? "s" : ""}${otherWorkspaceCount > 0 ? ` (${otherWorkspaceCount} in other workspaces)` : ""}`}
      >
        <span className="badge-icon"><IconZap size={13} /></span>
        <span className="badge-count">{totalCount}</span>
        {otherWorkspaceCount > 0 && (
          <span className="badge-other">+{otherWorkspaceCount}</span>
        )}
      </button>

      <div className="workspace-manager-dropdown-shell" aria-hidden={!isOpen}>
        <div className="workspace-manager-dropdown-inner">
          <div className="workspace-manager-dropdown">
          <div className="dropdown-header">
            Running Agents
          </div>
          
          {workspaceGroups.map((group) => (
            <div key={group.workspace} className="workspace-group">
              <div 
                className={`workspace-header ${group.workspace === currentWorkspace ? "current" : ""}`}
                onClick={() => {
                  if (group.workspace !== currentWorkspace) {
                    onSwitchWorkspace(group.workspace);
                    setIsOpen(false);
                  }
                }}
              >
                <span className="workspace-icon"><IconFolderOpen size={14} /></span>
                <span className="workspace-name" title={group.workspace}>
                  {getWorkspaceName(group.workspace)}
                </span>
                {group.workspace === currentWorkspace && (
                  <span className="current-badge">current</span>
                )}
                {group.workspace !== currentWorkspace && (
                  <span className="switch-hint">click to switch</span>
                )}
              </div>
              
              {group.sessions.map((session) => (
                <div key={session.id} className="session-item">
                  <div className="session-info">
                    <span className="session-task" title={session.task}>
                      {session.task.length > 50 ? session.task.slice(0, 50) + "..." : session.task}
                    </span>
                    <span className="session-meta">
                      <span className="session-duration">{formatDuration(session.createdAt)}</span>
                      <span className={`session-status status-${session.status}`}>{session.status}</span>
                    </span>
                  </div>
                  <button
                    className="session-abort"
                    onClick={(e) => handleAbort(session.id, e)}
                    title="Abort this agent"
                  >
                    <IconX size={12} />
                  </button>
                </div>
              ))}
            </div>
          ))}
          
          {workspaceGroups.length === 0 && (
            <div className="no-sessions">No running agents</div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
