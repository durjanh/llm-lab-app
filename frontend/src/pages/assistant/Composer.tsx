import {
  ChatComposer,
  MenuItem,
  MenuNote,
  MenuSep,
  MenuTitle,
  MenuToggle,
  type ComposerModel,
} from '@/components/chat/ChatComposer';
import type {
  AssistantInfo,
  ChatSettings,
  Effort,
  McpServer,
  Provider,
  UploadedFile,
} from '@/services/assistantService';
import { Icon } from './parts';
import { accept } from './upload';

/* The assistant's message box: the shared chat composer, with the assistant's own items behind "+" (MCP servers,
   deck style, plan approval and the run budget) and tags for the ones that are on. */

export type { Uploading } from '@/components/chat/ChatComposer';

const PROVIDER: Record<Provider, string> = {
  anthropic: 'Claude',
  'azure-openai': 'GPT on Azure',
  local: 'On this machine',
};

export function effortsFor(info: AssistantInfo, model: string): Effort[] {
  return info.models.find((m) => m.id === model)?.efforts ?? [];
}

/** The effort to use for a model: the one asked for if the model accepts it, else medium, else its first. */
export function fitEffort(info: AssistantInfo, model: string, wanted: Effort): Effort {
  const list = effortsFor(info, model);
  if (!list.length || list.includes(wanted)) return wanted;
  return list.includes('medium') ? 'medium' : list[0];
}

/** The effort to send: none ('') for a model that takes no effort setting, such as the local model. */
export function effortToSend(info: AssistantInfo, model: string, effort: Effort): Effort | '' {
  return effortsFor(info, model).length ? effort : '';
}

/** The assistant's models as the shared picker lists them: grouped by provider, with their context window. */
export function pickerModels(info: AssistantInfo): ComposerModel[] {
  return info.models.map((m) => ({
    id: m.id,
    name: m.name,
    group: PROVIDER[m.provider] ?? m.provider,
    efforts: m.efforts,
    meta: `${Math.round(m.context_window / 1000)}k`,
  }));
}

export function Composer({
  info,
  settings,
  onSettings,
  text,
  onText,
  attachments,
  uploading,
  problems,
  onPick,
  onRemove,
  onSend,
  onStop,
  running,
  blocked,
  mcp,
  mcpProblem,
  onManageMcp,
  hero = false,
  lastRouted = null,
}: {
  info: AssistantInfo;
  settings: ChatSettings;
  onSettings: (s: ChatSettings) => void;
  text: string;
  onText: (t: string) => void;
  attachments: UploadedFile[];
  uploading: { name: string; progress: number }[];
  problems: string[];
  onPick: (files: File[]) => void;
  onRemove: (id: string) => void;
  /** Resolves true when the message was accepted, so the box can clear. */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  running: boolean;
  /** Why sending is not possible right now, if it is not. */
  blocked: string | null;
  /** The person's MCP servers, and the ids enabled in this chat. */
  mcp: { servers: McpServer[]; enabled: string[] };
  /** Why MCP servers cannot be used here (for example, a backend without them). */
  mcpProblem: string | null;
  onManageMcp: () => void;
  /** The large version on the start screen. */
  hero?: boolean;
  /** The model Auto chose for this chat's last turn, for the pill. */
  lastRouted?: string | null;
}) {
  // Servers switched on, plus any this chat chose that are switched off globally (shown as off).
  const liveServers = mcp.servers.filter((s) => s.enabled || mcp.enabled.includes(s.id));
  const usedServers = mcp.servers.filter((s) => s.enabled && mcp.enabled.includes(s.id));
  const toggleServer = (id: string, on: boolean) => {
    const now = mcp.enabled.filter((x) => x !== id);
    onSettings({ ...settings, mcp_servers: on ? [...now, id] : now });
  };
  const brand = settings.deck_brand ? info.brands?.find((b) => b.id === settings.deck_brand) : undefined;

  return (
    <ChatComposer
      idBase="as"
      hero={hero}
      text={text}
      onText={onText}
      onSend={onSend}
      onStop={onStop}
      running={running}
      blocked={blocked}
      attachments={attachments}
      uploading={uploading}
      problems={problems}
      onPick={onPick}
      onRemove={onRemove}
      accept={accept(info.upload)}
      maxFiles={info.upload.max_files}
      models={pickerModels(info)}
      model={settings.model}
      effort={settings.effort}
      onModel={(model) => onSettings({ ...settings, model, effort: fitEffort(info, model, settings.effort) })}
      onEffort={(effort) => onSettings({ ...settings, effort: effort as Effort })}
      auto={{
        on: Boolean(settings.auto),
        onToggle: (on) => onSettings({ ...settings, auto: on }),
        last: lastRouted ? (info.models.find((m) => m.id === lastRouted)?.name ?? lastRouted) : null,
      }}
      placeholder={hero ? 'Describe a task, ask a question, or drop in files…' : 'Reply, or ask for something new…'}
      tags={
        <>
          {usedServers.length > 0 && (
            <span className="cc-tag" title={usedServers.map((s) => s.name).join(', ')}>
              <Icon name="plug" />
              {usedServers.length}
            </span>
          )}
          {settings.approve_plans && <span className="cc-tag">Approve plans</span>}
          {brand && <span className="cc-tag">{brand.name} decks</span>}
        </>
      }
      menu={(close) => (
        <>
          <MenuSep />
          <MenuTitle>
            <Icon name="plug" /> MCP servers
          </MenuTitle>
          {mcpProblem ? (
            <MenuNote>{mcpProblem}</MenuNote>
          ) : liveServers.length === 0 ? (
            <MenuNote>No servers yet. Add one to give the agent more tools.</MenuNote>
          ) : (
            liveServers.map((s) => (
              <MenuToggle
                key={s.id}
                on={mcp.enabled.includes(s.id)}
                onChange={(v) => toggleServer(s.id, v)}
                label={s.name}
              >
                <span className={`as-dot-status ${s.enabled ? s.status : ''}`} aria-hidden="true" />
                <span className="cc-pop-meta">{s.enabled ? `${s.tools.length} tools` : 'off'}</span>
              </MenuToggle>
            ))
          )}
          {!mcpProblem && (
            <MenuItem
              onClick={() => {
                close();
                onManageMcp();
              }}
            >
              Manage servers…
            </MenuItem>
          )}
          <MenuSep />
          <MenuTitle>Deck style</MenuTitle>
          {[{ id: '', name: 'House style', template: null } as const, ...(info.brands ?? [])].map((b) => (
            <MenuItem
              key={b.id || 'house'}
              checked={(settings.deck_brand ?? '') === b.id}
              onClick={() => onSettings({ ...settings, deck_brand: b.id })}
              title={b.id ? (b.template ?? 'No template: colours and notes only') : 'The professional default'}
            >
              {b.name}
            </MenuItem>
          ))}
          {!info.brands?.length && (
            <MenuNote>Add a company template in generated/brands/&lt;name&gt;/ to offer it here.</MenuNote>
          )}
          <MenuSep />
          <MenuToggle
            on={settings.approve_plans}
            onChange={(v) => onSettings({ ...settings, approve_plans: v })}
            label="Approve plans first"
          />
          <label className="cc-field">
            <span>Run budget $</span>
            <input
              type="number"
              min={0.05}
              max={20}
              step={0.05}
              value={settings.run_budget_usd}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) onSettings({ ...settings, run_budget_usd: Math.min(20, Math.max(0.05, v)) });
              }}
            />
          </label>
          <MenuNote>The most one message may spend, its sub-agents included.</MenuNote>
        </>
      )}
    />
  );
}
