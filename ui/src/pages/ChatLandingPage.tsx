import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Code2,
  Cpu,
  Loader2,
  MessageSquare,
  Paperclip,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'

import { useWorkspaces } from '../contexts/WorkspacesContext'
import { installHintFor } from '../components/workspace/agentInstall'

/** Glyph per agent CLI, for the runtime picker (claude/codex/opencode/pi). */
const AGENT_ICONS: Record<string, LucideIcon> = {
  claude: Sparkles,
  codex: Cpu,
  opencode: Code2,
  pi: Bot,
}

/**
 * Quick-chat landing — the "type a message → you're in" front door for the
 * "Ask Alice" activity. A single composer: the user types a first message and
 * hits send; `quickChat` reuses-or-creates the chat workspace, spawns a fresh
 * session seeded with that message (the agent CLI opens already working on it),
 * and focuses into the session's terminal tab. No template/CLI pickers in the
 * way — the bottom row shows the workspace type (Chat) and a small runtime
 * picker (the four agent CLIs), defaulting to the workspace's default agent.
 */
export function ChatLandingPage() {
  const { t } = useTranslation()
  const { quickChat, agents } = useWorkspaces()

  // The selectable agent runtimes = the agent CLIs (the bare shell has no agent
  // loop, so it can't be seeded with a first message).
  const cliAgents = agents.filter((a) => a.id !== 'shell')

  const [value, setValue] = useState('')
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const agentBoxRef = useRef<HTMLDivElement>(null)

  // Backend probes the host PATH and reports `installed` per agent. Treat a
  // missing value as installed (older backend / don't gate on a stale shape).
  const isInstalled = (a: { installed?: boolean }) => a.installed !== false
  const anyInstalled = cliAgents.some(isInstalled)
  // Whether the `/agents` fetch has actually landed. Before it does, `agents`
  // is `[]` and `anyInstalled` is falsely false — which would flash the
  // "nothing installed, go install something" nudge on every page load until
  // the request resolves. The backend registers claude/codex/opencode/pi/shell
  // unconditionally, so a loaded list always has ≥1 CLI agent; an empty
  // `cliAgents` means "still loading" (or the fetch failed) — in both cases we
  // must NOT assert that the host is missing its runtimes.
  const agentsKnown = cliAgents.length > 0

  // Default to the first INSTALLED CLI until the user picks one — so a fresh
  // box that only has, say, codex doesn't silently default to a missing claude.
  const firstInstalled = cliAgents.find(isInstalled)
  const effectiveAgent = selectedAgent ?? firstInstalled?.id ?? cliAgents[0]?.id ?? null
  const selectedInfo = cliAgents.find((a) => a.id === effectiveAgent) ?? null
  const SelectedIcon = selectedInfo ? AGENT_ICONS[selectedInfo.id] : undefined
  // Surface install guidance when the chosen runtime isn't on PATH.
  const selectedMissing = selectedInfo != null && !isInstalled(selectedInfo)
  const installHint = selectedInfo ? installHintFor(selectedInfo.id) : undefined

  const canSend = value.trim().length > 0 && !launching

  // Close the agent menu on an outside click.
  useEffect(() => {
    if (!agentMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (agentBoxRef.current && !agentBoxRef.current.contains(e.target as Node)) {
        setAgentMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [agentMenuOpen])

  const submit = async () => {
    const prompt = value.trim()
    if (!prompt || launching) return
    setError(null)
    setLaunching(true)
    try {
      // On success this focuses the new session's terminal tab; the landing tab
      // stays open in the background, so clear it for next time.
      await quickChat(prompt, effectiveAgent ?? undefined)
      setValue('')
    } catch (err) {
      console.error('chatLanding.quick_chat_failed', err)
      setError(t('chatLanding.error'))
    } finally {
      setLaunching(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits; Shift+Enter inserts a newline (standard chat-composer feel).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const useExample = (text: string) => {
    setValue(text)
    textareaRef.current?.focus()
  }

  return (
    <div className="relative h-full w-full overflow-auto bg-bg flex flex-col items-center justify-center px-4 py-8 md:px-6 md:py-10">
      {/* Ask-Alice backdrop — full-bleed, responsive-only layers (gradient wash
          + faint grid). The #302 mock's %-positioned circle / diagonal bars were
          dropped: they drift on portrait and read as pixel-placed art, not a
          responsive surface. pointer-events-none so it never intercepts clicks. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-overlay to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-[38%] bg-gradient-to-t from-overlay-strong to-transparent" />
        <div className="absolute inset-0 opacity-[0.06] [background-image:linear-gradient(to_right,var(--color-text)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-text)_1px,transparent_1px)] [background-size:96px_96px]" />
      </div>

      <div className="relative z-10 w-full max-w-2xl flex flex-col gap-5">
        <div className="text-center space-y-1.5">
          <h1 className="text-xl md:text-2xl font-semibold text-text">{t('chatLanding.heading')}</h1>
          <p className="text-sm text-text-muted">{t('chatLanding.subheading')}</p>
        </div>

        <div className="bg-bg-secondary/60 border border-border/60 rounded-2xl px-3 pt-3 pb-2 transition-colors focus-within:border-accent/50">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('chatLanding.placeholder')}
            rows={3}
            autoFocus
            className="w-full bg-transparent resize-none outline-none text-text placeholder:text-text-muted/50 text-[15px] px-2 py-1.5 min-h-[72px] max-h-[40vh]"
          />
          <div className="flex items-center justify-between px-1 pt-1">
            <div className="flex items-center gap-2">
              {/* Workspace type (Chat). Static — quick-chat always targets the chat template. */}
              <span className="inline-flex items-center gap-1.5 text-[11px] text-text-muted bg-bg-tertiary px-2 py-1 rounded-md">
                <MessageSquare className="w-3 h-3" />
                {t('chatLanding.workspaceType')}
              </span>

              {/* Agent runtime picker — one of the installed CLIs. */}
              <div ref={agentBoxRef} className="relative">
                <button
                  type="button"
                  onClick={() => setAgentMenuOpen((o) => !o)}
                  disabled={cliAgents.length === 0}
                  aria-haspopup="menu"
                  aria-expanded={agentMenuOpen}
                  aria-label={t('chatLanding.selectAgent')}
                  className="inline-flex items-center gap-1.5 text-[11px] text-text-muted bg-bg-tertiary px-2 py-1 rounded-md transition-colors hover:text-text disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {SelectedIcon ? <SelectedIcon className="w-3 h-3" /> : null}
                  {selectedInfo?.displayName ?? t('chatLanding.defaultAgent')}
                  <ChevronDown className="w-3 h-3 opacity-60" />
                </button>
                {agentMenuOpen && cliAgents.length > 0 && (
                  <div
                    role="menu"
                    className="absolute bottom-full left-0 mb-1 min-w-[170px] py-1 bg-bg-secondary border border-border/70 rounded-lg shadow-lg z-10"
                  >
                    {cliAgents.map((a) => {
                      const Icon = AGENT_ICONS[a.id]
                      const active = a.id === effectiveAgent
                      const missing = !isInstalled(a)
                      return (
                        <button
                          key={a.id}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setSelectedAgent(a.id)
                            setAgentMenuOpen(false)
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors hover:bg-bg-tertiary ${active ? 'text-accent' : missing ? 'text-text-muted/60' : 'text-text'}`}
                        >
                          {Icon ? <Icon className="w-3.5 h-3.5 shrink-0" /> : <span className="w-3.5 shrink-0" />}
                          <span className="flex-1">{a.displayName}</span>
                          {missing && (
                            <span className="text-[10px] text-text-muted/70 shrink-0">
                              {t('chatLanding.agentNotInstalled')}
                            </span>
                          )}
                          {active && <Check className="w-3.5 h-3.5 shrink-0" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled
                title={t('chatLanding.attachSoon')}
                aria-label={t('chatLanding.attach')}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted/50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Paperclip className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSend}
                title={t('chatLanding.send')}
                aria-label={t('chatLanding.send')}
                className="w-8 h-8 rounded-lg flex items-center justify-center bg-accent text-white transition-colors hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {launching ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {error !== null && <div className="text-[12px] text-red px-1">{error}</div>}

        {/* Runtime install guidance — the conversion nudge. Shows when no agent
            CLI is installed at all, or the selected one is missing from PATH.
            Detection is a hint, not a gate, so send stays enabled (PATH probing
            can be wrong); this just tells the user what to install. Gated on
            `agentsKnown` so it never flashes during the initial /agents load. */}
        {agentsKnown && !anyInstalled ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[12px] space-y-1.5">
            <div className="font-medium text-text">{t('chatLanding.noAgentsTitle')}</div>
            <p className="text-text-muted">{t('chatLanding.noAgentsBody')}</p>
            <code className="block font-mono text-[11px] text-text bg-bg-tertiary rounded px-2 py-1 select-all">
              {installHintFor('claude')!.cmd}
            </code>
          </div>
        ) : selectedMissing && selectedInfo ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[12px] space-y-1.5">
            <p className="text-text-muted">
              {t('chatLanding.agentMissing', { name: selectedInfo.displayName })}
            </p>
            {installHint?.cmd && (
              <div className="flex items-center gap-2">
                <span className="text-text-muted/70">{t('chatLanding.installLabel')}</span>
                <code className="font-mono text-[11px] text-text bg-bg-tertiary rounded px-2 py-1 select-all">
                  {installHint.cmd}
                </code>
              </div>
            )}
            {installHint?.url && (
              <a
                href={installHint.url}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-accent hover:underline"
              >
                {t('chatLanding.installDocs')} ↗
              </a>
            )}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 px-1">
          <span className="text-[11px] text-text-muted/70">{t('chatLanding.examplesLabel')}</span>
          {[t('chatLanding.ex1'), t('chatLanding.ex2'), t('chatLanding.ex3')].map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => useExample(ex)}
              disabled={launching}
              className="text-[12px] text-text-muted bg-bg-secondary/60 border border-border/50 rounded-full px-3 py-1 transition-colors hover:border-accent/40 hover:text-text disabled:opacity-40"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
