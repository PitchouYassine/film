import React from 'react';
import { AlertCircle, Check, Lock } from 'lucide-react';
import { NavPage, Project, WorkflowStageId } from '../types/studio';
import { computeStageStatuses } from '../lib/workflowStages';

export interface UnifiedWorkflowStep {
  id: 'projects' | 'translator' | 'voice' | 'editor' | 'export';
  number: string;
  label: string;
  shortLabel: string;
  completed: boolean;
  needsAttention: boolean;
  active: boolean;
  accessible: boolean;
}

interface WorkflowStepperBarProps {
  project: Project | null;
  activePage: NavPage;
  onNavigate: (page: NavPage) => void;
  compact?: boolean;
}

function mapNavPageToStageId(page: NavPage): WorkflowStageId {
  if (page === 'translator' || page === 'voice' || page === 'editor' || page === 'captions' || page === 'export') {
    return page;
  }
  if (page === 'effects' || page === 'blur' || page === 'branding') {
    return 'editor';
  }
  return 'dashboard';
}

export function WorkflowStepperBar({
  project,
  activePage,
  onNavigate,
  compact = false,
}: WorkflowStepperBarProps) {
  const hasVideo = Boolean(project?.sourceVideoUrl);
  const activeStageId = mapNavPageToStageId(activePage);
  const stageMap = new Map(
    computeStageStatuses(project, activeStageId).map((s) => [s.id, s])
  );

  const editorPages: NavPage[] = ['editor', 'captions', 'effects', 'blur', 'branding'];

  const steps: UnifiedWorkflowStep[] = [
    {
      id: 'projects',
      number: '1',
      label: 'Import',
      shortLabel: 'Import',
      completed: hasVideo,
      needsAttention: false,
      active: activePage === 'projects' || activePage === 'dashboard',
      accessible: true,
    },
    {
      id: 'translator',
      number: '2',
      label: 'Translation',
      shortLabel: 'Translate',
      completed: stageMap.get('translator')?.status === 'Completed',
      needsAttention: stageMap.get('translator')?.status === 'Needs Attention',
      active: activePage === 'translator',
      accessible: hasVideo,
    },
    {
      id: 'voice',
      number: '3',
      label: 'Voice Studio',
      shortLabel: 'Voice',
      completed: stageMap.get('voice')?.status === 'Completed',
      needsAttention: stageMap.get('voice')?.status === 'Needs Attention',
      active: activePage === 'voice',
      accessible: hasVideo,
    },
    {
      id: 'editor',
      number: '4',
      label: 'Video Editor',
      shortLabel: 'Editor',
      completed: stageMap.get('editor')?.status === 'Completed',
      needsAttention: stageMap.get('editor')?.status === 'Needs Attention',
      active: editorPages.includes(activePage),
      accessible: hasVideo,
    },
    {
      id: 'export',
      number: '5',
      label: 'Export',
      shortLabel: 'Export',
      completed: stageMap.get('export')?.status === 'Completed',
      needsAttention: stageMap.get('export')?.status === 'Needs Attention',
      active: activePage === 'export',
      accessible: hasVideo,
    },
  ];

  return (
    <div
      className={`border-b border-white/[0.08] bg-[#0B0B0F] px-2.5 sm:px-4 shrink-0 ${
        compact ? 'py-1' : 'py-1.5'
      }`}
    >
      <nav
        aria-label="Project workflow pipeline"
        className="flex items-center justify-start sm:justify-center gap-1 sm:gap-1.5 overflow-x-auto no-scrollbar"
      >
        {steps.map((step, idx) => {
          const isLast = idx === steps.length - 1;
          return (
            <React.Fragment key={step.id}>
              <button
                type="button"
                onClick={() => onNavigate(step.id)}
                disabled={!step.accessible}
                aria-current={step.active ? 'step' : undefined}
                className={`min-h-[32px] px-2.5 py-1 rounded-lg border text-[11px] sm:text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  step.active
                    ? 'bg-violet-600/20 border-violet-500/60 text-white'
                    : step.needsAttention
                    ? 'bg-amber-500/10 border-amber-500/35 text-amber-200 hover:bg-amber-500/15'
                    : step.completed
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/15'
                    : 'bg-[#141419] border-white/[0.07] text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span
                  className={`w-4 h-4 rounded-full text-[10px] font-mono font-semibold flex items-center justify-center shrink-0 tabular-nums ${
                    step.active
                      ? 'bg-violet-500 text-white'
                      : step.needsAttention
                      ? 'bg-amber-500/25 text-amber-300'
                      : step.completed
                      ? 'bg-emerald-500/25 text-emerald-300'
                      : !step.accessible
                      ? 'bg-zinc-800 text-zinc-500'
                      : 'bg-zinc-800 text-zinc-300'
                  }`}
                >
                  {step.needsAttention ? (
                    <AlertCircle className="w-2.5 h-2.5" />
                  ) : step.completed ? (
                    <Check className="w-2.5 h-2.5" />
                  ) : !step.accessible ? (
                    <Lock className="w-2.5 h-2.5" />
                  ) : (
                    step.number
                  )}
                </span>
                <span className="hidden sm:inline">{step.label}</span>
                <span className="sm:hidden">{step.shortLabel}</span>
              </button>

              {!isLast && (
                <div
                  aria-hidden="true"
                  className={`w-3 sm:w-5 h-px shrink-0 ${
                    step.completed ? 'bg-emerald-500/40' : 'bg-white/[0.08]'
                  }`}
                />
              )}
            </React.Fragment>
          );
        })}
      </nav>
    </div>
  );
}
