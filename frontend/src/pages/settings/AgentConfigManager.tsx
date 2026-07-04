import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogIn,
  Save,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  agentSettingsApi,
  type AgentNativeFile,
  type AgentSettingInfo,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { SettingsSection } from './SettingsSection';

// ─── Storage targets ────────────────────────────────────────────────────────
// A shortcut field reads/writes one of: an environment variable, a (possibly
// nested) key in a native JSON file, or a top-level key in a native TOML file.
// All three two-way sync with the raw editors shown alongside.

type Target =
  | { kind: 'env'; key: string }
  | { kind: 'json'; fileId: string; path: string[] }
  | { kind: 'toml'; fileId: string; key: string };

type ConfigField = {
  label: string;
  target: Target;
  control?: 'text' | 'password' | 'select';
  placeholder?: string;
  options?: { value: string; label: string }[];
  span2?: boolean;
  /** Show this field only when the active auth method is in this list. */
  authMethods?: string[];
};

type AuthMethodOption = {
  value: string;
  label: string;
  hint: string;
  /** Targets cleared when this method is selected. */
  clear?: Target[];
  /** When selected, treat this file's presence as "logged in". */
  loginFileId?: string;
};

type AgentSpec = {
  subtitle: string;
  auth?: { options: AuthMethodOption[]; detect: (read: Reader) => string };
  fields: ConfigField[];
};

type Reader = (target: Target) => string;

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
];

const CLAUDE_EFFORT_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
];

const AGENT_SPECS: Record<string, AgentSpec> = {
  claude_code: {
    subtitle:
      '支持 API URL、API Key 与 Claude 模型快捷配置，并与 settings.json 双向联动。',
    auth: {
      options: [
        {
          value: 'official',
          label: '官网订阅',
          hint: '使用 Anthropic 官方订阅，无需 API Key。',
          clear: [
            {
              kind: 'json',
              fileId: 'settings',
              path: ['env', 'ANTHROPIC_API_KEY'],
            },
            {
              kind: 'json',
              fileId: 'settings',
              path: ['env', 'ANTHROPIC_BASE_URL'],
            },
          ],
        },
        {
          value: 'custom',
          label: '自定义 API',
          hint: '使用自定义 API URL 与 API Key。',
        },
      ],
      detect: (read) =>
        read({
          kind: 'json',
          fileId: 'settings',
          path: ['env', 'ANTHROPIC_API_KEY'],
        })
          ? 'custom'
          : 'official',
    },
    fields: [
      {
        label: 'API Base URL',
        target: {
          kind: 'json',
          fileId: 'settings',
          path: ['env', 'ANTHROPIC_BASE_URL'],
        },
        placeholder: 'https://api.anthropic.com',
        authMethods: ['custom'],
      },
      {
        label: 'API Key',
        target: {
          kind: 'json',
          fileId: 'settings',
          path: ['env', 'ANTHROPIC_API_KEY'],
        },
        control: 'password',
        placeholder: 'sk-ant-...',
        authMethods: ['custom'],
      },
      {
        label: '主模型',
        target: {
          kind: 'json',
          fileId: 'settings',
          path: ['env', 'ANTHROPIC_MODEL'],
        },
        placeholder: 'claude-sonnet-4-6',
      },
      {
        label: '推理模型 (thinking)',
        target: {
          kind: 'json',
          fileId: 'settings',
          path: ['env', 'ANTHROPIC_REASONING_MODEL'],
        },
        placeholder: 'claude-opus-4-8',
      },
      {
        label: 'Haiku 默认模型',
        target: {
          kind: 'json',
          fileId: 'settings',
          path: ['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
        },
        placeholder: 'claude-haiku-4-5',
      },
      {
        label: 'Sonnet 默认模型',
        target: {
          kind: 'json',
          fileId: 'settings',
          path: ['env', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
        },
        placeholder: 'claude-sonnet-4-6',
      },
      {
        label: 'Opus 默认模型',
        target: {
          kind: 'json',
          fileId: 'settings',
          path: ['env', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
        },
        placeholder: 'claude-opus-4-8',
        span2: true,
      },
      {
        label: '推理级别',
        target: { kind: 'json', fileId: 'settings', path: ['effortLevel'] },
        control: 'select',
        options: CLAUDE_EFFORT_OPTIONS,
        span2: true,
      },
    ],
  },
  codex: {
    subtitle:
      '支持 API URL、API Key、模型名称、Reasoning Effort 快捷配置，并与 auth.json / config.toml 双向联动。',
    auth: {
      options: [
        {
          value: 'official',
          label: '官网订阅 (ChatGPT)',
          hint: '使用 ChatGPT 官网订阅登录，无需配置 API Key。',
          loginFileId: 'auth',
          clear: [
            { kind: 'env', key: 'OPENAI_API_KEY' },
            { kind: 'env', key: 'OPENAI_BASE_URL' },
          ],
        },
        {
          value: 'api_key',
          label: 'API Key',
          hint: '使用 OpenAI API Key。',
        },
      ],
      detect: (read) =>
        read({ kind: 'env', key: 'OPENAI_API_KEY' }) ? 'api_key' : 'official',
    },
    fields: [
      {
        label: 'API Base URL',
        target: { kind: 'env', key: 'OPENAI_BASE_URL' },
        placeholder: 'https://api.openai.com/v1',
        authMethods: ['api_key'],
      },
      {
        label: 'API Key',
        target: { kind: 'env', key: 'OPENAI_API_KEY' },
        control: 'password',
        placeholder: 'sk-...',
        authMethods: ['api_key'],
      },
      {
        label: 'Model',
        target: { kind: 'toml', fileId: 'config', key: 'model' },
        placeholder: 'gpt-5.4',
      },
      {
        label: 'Reasoning Effort',
        target: {
          kind: 'toml',
          fileId: 'config',
          key: 'model_reasoning_effort',
        },
        control: 'select',
        options: EFFORT_OPTIONS,
      },
    ],
  },
  gemini: {
    subtitle:
      'API Key 或 Google Cloud 凭据快捷配置，并与 settings.json 双向联动。',
    auth: {
      options: [
        {
          value: 'api_key',
          label: 'API Key',
          hint: '使用 Gemini API Key。',
          clear: [
            { kind: 'env', key: 'GOOGLE_CLOUD_PROJECT' },
            { kind: 'env', key: 'GOOGLE_CLOUD_LOCATION' },
          ],
        },
        {
          value: 'vertex',
          label: 'Google Cloud',
          hint: '使用 Vertex AI / GCP 凭据。',
          clear: [{ kind: 'env', key: 'GEMINI_API_KEY' }],
        },
      ],
      detect: (read) =>
        read({ kind: 'env', key: 'GEMINI_API_KEY' }) ? 'api_key' : 'vertex',
    },
    fields: [
      {
        label: 'API Key',
        target: { kind: 'env', key: 'GEMINI_API_KEY' },
        control: 'password',
        placeholder: 'AIza...',
        authMethods: ['api_key'],
        span2: true,
      },
      {
        label: 'Google Cloud Project',
        target: { kind: 'env', key: 'GOOGLE_CLOUD_PROJECT' },
        placeholder: 'my-project',
        authMethods: ['vertex'],
      },
      {
        label: 'Google Cloud Location',
        target: { kind: 'env', key: 'GOOGLE_CLOUD_LOCATION' },
        placeholder: 'us-central1',
        authMethods: ['vertex'],
      },
    ],
  },
  opencode: {
    subtitle: 'Model 与 Small Model 快捷配置，并与 opencode.json 双向联动。',
    fields: [
      {
        label: 'Model',
        target: { kind: 'json', fileId: 'config', path: ['model'] },
        placeholder: 'anthropic/claude-sonnet-4-6',
      },
      {
        label: 'Small Model',
        target: { kind: 'json', fileId: 'config', path: ['small_model'] },
        placeholder: 'anthropic/claude-haiku-4-5',
      },
    ],
  },
  openclaw: {
    subtitle: 'OpenClaw 通过网关环境变量配置（无独立配置文件）。',
    fields: [
      {
        label: 'Gateway URL',
        target: { kind: 'env', key: 'OPENCLAW_GATEWAY_URL' },
        placeholder: 'https://gateway.example.com',
        span2: true,
      },
      {
        label: 'Gateway Token',
        target: { kind: 'env', key: 'OPENCLAW_GATEWAY_TOKEN' },
        control: 'password',
        placeholder: '网关访问令牌',
      },
      {
        label: 'Session Key',
        target: { kind: 'env', key: 'OPENCLAW_SESSION_KEY' },
        control: 'password',
        placeholder: '会话密钥',
      },
    ],
  },
  cline: {
    subtitle:
      'Cline 的服务商、模型与密钥保存在 globalState.json / secrets.json（按服务商不同字段各异），请在下方原生文件中编辑。',
    fields: [],
  },
  hermes: {
    subtitle:
      'Hermes 的服务商与模型保存在 config.yaml / .env，请在下方原生文件中编辑。',
    fields: [],
  },
};

// ─── env (KEY=VALUE) helpers ────────────────────────────────────────────────

function parseEnvJson(
  envJson: string | null | undefined
): Record<string, string> {
  if (!envJson?.trim()) return {};
  try {
    const parsed = JSON.parse(envJson) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')])
    );
  } catch {
    return {};
  }
}

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0)
      out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function envMapToText(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function getEnvValue(text: string, key: string): string {
  return parseEnvText(text)[key] ?? '';
}

function setEnvValue(text: string, key: string, value: string): string {
  const map = parseEnvText(text);
  if (value) map[key] = value;
  else delete map[key];
  return envMapToText(map);
}

// ─── nested JSON helpers ────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

function parseJsonObject(text: string): JsonObject {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function getJsonPath(text: string, path: string[]): string {
  let cursor: unknown = parseJsonObject(text);
  for (const key of path) {
    if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
      cursor = (cursor as JsonObject)[key];
    } else {
      return '';
    }
  }
  return cursor == null ? '' : String(cursor);
}

function setJsonPath(text: string, path: string[], value: string): string {
  const root = parseJsonObject(text);
  let cursor: JsonObject = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = cursor[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as JsonObject;
  }
  const last = path[path.length - 1];
  if (value) cursor[last] = value;
  else delete cursor[last];
  return JSON.stringify(root, null, 2);
}

// ─── TOML top-level scalar helpers (preserve tables/comments below) ─────────

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function topLevelEnd(lines: string[]): number {
  const idx = lines.findIndex((line) => /^\s*\[/.test(line));
  return idx === -1 ? lines.length : idx;
}

function getTomlValue(text: string, key: string): string {
  const lines = text.split('\n');
  const end = topLevelEnd(lines);
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`);
  for (let i = 0; i < end; i++) {
    const match = lines[i].match(re);
    if (match) {
      const raw = match[1].trim();
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        return raw.slice(1, -1);
      }
      return raw;
    }
  }
  return '';
}

function setTomlValue(text: string, key: string, value: string): string {
  const lines = text.length ? text.split('\n') : [];
  const end = topLevelEnd(lines);
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const line = `${key} = ${JSON.stringify(value)}`;

  for (let i = 0; i < end; i++) {
    if (re.test(lines[i])) {
      if (!value) lines.splice(i, 1);
      else lines[i] = line;
      return lines.join('\n');
    }
  }
  if (!value) return text;
  lines.splice(end, 0, line);
  return lines.join('\n');
}

/** Read `key = true` inside a `[section]` table. */
function getTomlSectionBool(
  text: string,
  section: string,
  key: string
): boolean {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start === -1) return false;
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`);
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break;
    const match = lines[i].match(re);
    if (match) return match[1].trim() === 'true';
  }
  return false;
}

/** Set/remove `key = true` inside a `[section]` table (created on demand). */
function setTomlSectionBool(
  text: string,
  section: string,
  key: string,
  on: boolean
): string {
  const lines = text.length ? text.split('\n') : [];
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);

  if (start !== -1) {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    for (let i = start + 1; i < end; i++) {
      if (keyRe.test(lines[i])) {
        if (on) lines[i] = `${key} = true`;
        else lines.splice(i, 1);
        return lines.join('\n');
      }
    }
    if (on) {
      lines.splice(start + 1, 0, `${key} = true`);
      return lines.join('\n');
    }
    return text;
  }
  if (!on) return text;
  const base = text.replace(/\s+$/, '');
  const block = `[${section}]\n${key} = true`;
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/** Codex feature toggles backed by config.toml (matching the codex CLI keys). */
const CODEX_TOGGLES: {
  label: string;
  get: (toml: string) => boolean;
  set: (toml: string, on: boolean) => string;
}[] = [
  {
    label: '启用 WebSocket',
    get: (toml) =>
      getTomlSectionBool(toml, 'features', 'responses_websockets_v2'),
    set: (toml, on) =>
      setTomlSectionBool(toml, 'features', 'responses_websockets_v2', on),
  },
  {
    label: '启用 Skills',
    get: (toml) => getTomlSectionBool(toml, 'features', 'skills'),
    set: (toml, on) => setTomlSectionBool(toml, 'features', 'skills', on),
  },
  {
    label: '启用 Fast',
    get: (toml) => getTomlValue(toml, 'service_tier') === 'fast',
    set: (toml, on) => setTomlValue(toml, 'service_tier', on ? 'fast' : ''),
  },
];

// ─── Component ──────────────────────────────────────────────────────────────

export function AgentConfigManager({
  agentType,
  setting,
  onSaved,
}: {
  agentType: string;
  setting: AgentSettingInfo | null;
  onSaved: () => void;
}) {
  const hasSetting = !!setting;
  const spec = AGENT_SPECS[agentType];

  const [envText, setEnvText] = useState('');
  const [files, setFiles] = useState<AgentNativeFile[]>([]);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [authMethod, setAuthMethod] = useState('');
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setEnvText(envMapToText(parseEnvJson(setting?.env_json)));
    setError(null);
    setSaved(null);
  }, [agentType, setting?.env_json]);

  useEffect(() => {
    let active = true;
    setLoadingFiles(true);
    setFilesError(null);
    void agentSettingsApi
      .readNativeFiles(agentType)
      .then((loaded) => {
        if (!active) return;
        const loadedContents = Object.fromEntries(
          loaded.map((file) => [file.id, file.content ?? ''])
        );
        setFiles(loaded);
        setContents(loadedContents);

        // Detect the active auth method from persisted values.
        if (spec?.auth) {
          const envMap = parseEnvJson(setting?.env_json);
          const read: Reader = (target) => {
            if (target.kind === 'env') return envMap[target.key] ?? '';
            if (target.kind === 'json')
              return getJsonPath(
                loadedContents[target.fileId] ?? '',
                target.path
              );
            return getTomlValue(
              loadedContents[target.fileId] ?? '',
              target.key
            );
          };
          setAuthMethod(spec.auth.detect(read));
        }
      })
      .catch((err) => {
        if (!active) return;
        setFiles([]);
        setContents({});
        setFilesError(err instanceof Error ? err.message : '加载配置文件失败');
      })
      .finally(() => {
        if (active) setLoadingFiles(false);
      });
    return () => {
      active = false;
    };
  }, [agentType, setting?.env_json, spec]);

  const readTarget = useCallback(
    (target: Target): string => {
      if (target.kind === 'env') return getEnvValue(envText, target.key);
      if (target.kind === 'json')
        return getJsonPath(contents[target.fileId] ?? '', target.path);
      return getTomlValue(contents[target.fileId] ?? '', target.key);
    },
    [envText, contents]
  );

  const writeTarget = useCallback((target: Target, value: string) => {
    if (target.kind === 'env') {
      setEnvText((current) => setEnvValue(current, target.key, value));
      return;
    }
    setContents((current) => ({
      ...current,
      [target.fileId]:
        target.kind === 'json'
          ? setJsonPath(current[target.fileId] ?? '', target.path, value)
          : setTomlValue(current[target.fileId] ?? '', target.key, value),
    }));
  }, []);

  const onAuthChange = useCallback(
    (method: string) => {
      setAuthMethod(method);
      const option = spec?.auth?.options.find((item) => item.value === method);
      for (const target of option?.clear ?? []) {
        writeTarget(target, '');
      }
    },
    [spec, writeTarget]
  );

  const saveEnv = useCallback(async () => {
    if (!hasSetting) return;
    setBusy('env');
    setError(null);
    setSaved(null);
    try {
      await agentSettingsApi.updatePreferences({
        agentType,
        envJson: JSON.stringify(parseEnvText(envText)),
      });
      setSaved('env');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存环境变量失败');
    } finally {
      setBusy(null);
    }
  }, [agentType, envText, hasSetting, onSaved]);

  const saveConfig = useCallback(async () => {
    setBusy('config');
    setError(null);
    setSaved(null);
    try {
      const changed = files
        .filter((file) => (contents[file.id] ?? '') !== (file.content ?? ''))
        .map((file) => ({ id: file.id, content: contents[file.id] ?? '' }));

      if (changed.length > 0) {
        const refreshed = await agentSettingsApi.writeNativeFiles(
          agentType,
          changed
        );
        setFiles(refreshed);
        setContents(
          Object.fromEntries(refreshed.map((f) => [f.id, f.content ?? '']))
        );
      }
      if (hasSetting) {
        await agentSettingsApi.updatePreferences({
          agentType,
          envJson: JSON.stringify(parseEnvText(envText)),
        });
      }
      setSaved('config');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存配置失败');
    } finally {
      setBusy(null);
    }
  }, [agentType, contents, envText, files, hasSetting, onSaved]);

  const login = useCallback(async () => {
    setError(null);
    try {
      await agentSettingsApi.openLoginTerminal(agentType);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法打开登录终端');
    }
  }, [agentType]);

  const renderField = (field: ConfigField) => {
    const value = readTarget(field.target);
    const onChange = (next: string) => writeTarget(field.target, next);

    if (field.control === 'select') {
      return (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="默认" />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    if (field.control === 'password') {
      const fieldId = JSON.stringify(field.target);
      const shown = revealed[fieldId] ?? false;
      return (
        <div className="flex items-center gap-2">
          <Input
            type={shown ? 'text' : 'password'}
            value={value}
            placeholder={field.placeholder}
            className="h-8 text-xs"
            onChange={(event) => onChange(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() =>
              setRevealed((current) => ({ ...current, [fieldId]: !shown }))
            }
          >
            {shown ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      );
    }
    return (
      <Input
        value={value}
        placeholder={field.placeholder}
        className="h-8 text-xs"
        onChange={(event) => onChange(event.target.value)}
      />
    );
  };

  const activeAuthOption = spec?.auth?.options.find(
    (option) => option.value === authMethod
  );
  const visibleFields = (spec?.fields ?? []).filter(
    (field) => !field.authMethods || field.authMethods.includes(authMethod)
  );
  const loginFile =
    activeAuthOption?.loginFileId != null
      ? files.find((file) => file.id === activeAuthOption.loginFileId)
      : undefined;

  return (
    <div className="space-y-4">
      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {/* Configuration management */}
      <SettingsSection
        id="config-management"
        title="配置管理"
        icon={Settings2}
        action={
          saved === 'config' ? (
            <span className="text-[11px] text-success">已保存</span>
          ) : null
        }
      >
        <div className="space-y-4">
          {spec ? (
            <p className="text-[11px] text-muted-foreground">{spec.subtitle}</p>
          ) : null}

          {spec?.auth ? (
            <div className="space-y-2">
              <Label className="text-[11px] text-muted-foreground">
                认证方式
              </Label>
              <Select value={authMethod} onValueChange={onAuthChange}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="选择认证方式" />
                </SelectTrigger>
                <SelectContent>
                  {spec.auth.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeAuthOption ? (
                <p className="text-[11px] text-muted-foreground">
                  {activeAuthOption.hint}
                </p>
              ) : null}
              {activeAuthOption?.loginFileId != null ? (
                <div className="flex flex-wrap items-center gap-3 text-[11px]">
                  {loginFile?.content ? (
                    <span className="flex items-center gap-1.5 text-success">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      账号已登录
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      未检测到登录凭据
                    </span>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => void login()}
                  >
                    <LogIn className="mr-1 h-3 w-3" />
                    {loginFile?.content ? '重新登录 / 切换账号' : '登录'}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {visibleFields.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {visibleFields.map((field) => (
                <div
                  key={`${field.label}:${JSON.stringify(field.target)}`}
                  className={cn('space-y-1.5', field.span2 && 'sm:col-span-2')}
                >
                  <Label className="text-[11px] text-muted-foreground">
                    {field.label}
                  </Label>
                  {renderField(field)}
                </div>
              ))}
            </div>
          ) : null}

          {/* Codex feature toggles (config.toml). */}
          {agentType === 'codex' ? (
            <div className="divide-y divide-border-subtle overflow-hidden rounded-lg border">
              {CODEX_TOGGLES.map((toggle) => {
                const tomlText = contents['config'] ?? '';
                return (
                  <div
                    key={toggle.label}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <span className="text-xs text-foreground">
                      {toggle.label}
                    </span>
                    <Switch
                      checked={toggle.get(tomlText)}
                      onCheckedChange={(on) =>
                        setContents((current) => ({
                          ...current,
                          config: toggle.set(current['config'] ?? '', on),
                        }))
                      }
                    />
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* Native config file editors */}
          {loadingFiles ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在加载配置文件…
            </div>
          ) : filesError ? (
            <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
              {filesError}
            </div>
          ) : files.length === 0 ? (
            !spec ? (
              <p className="text-[11px] text-muted-foreground">
                该 Agent 没有独立配置文件，通过下方环境变量进行配置。
              </p>
            ) : null
          ) : (
            files.map((file) => (
              <div key={file.id} className="space-y-1.5">
                <Label className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {file.label}
                  </span>
                  <code className="font-mono">{file.path}</code>
                  {!file.exists ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">
                      尚未创建
                    </span>
                  ) : null}
                </Label>
                <Textarea
                  value={contents[file.id] ?? ''}
                  spellCheck={false}
                  className="min-h-44 font-mono text-xs"
                  onChange={(event) =>
                    setContents((current) => ({
                      ...current,
                      [file.id]: event.target.value,
                    }))
                  }
                />
              </div>
            ))
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-8"
              disabled={busy !== null}
              onClick={() => void saveConfig()}
            >
              {busy === 'config' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-3.5 w-3.5" />
              )}
              保存配置
            </Button>
          </div>
        </div>
      </SettingsSection>

      {/* Environment variables (kept at the bottom) */}
      <SettingsSection
        id="environment-variables"
        title="环境变量"
        icon={KeyRound}
        action={
          saved === 'env' ? (
            <span className="text-[11px] text-success">已保存</span>
          ) : null
        }
      >
        <div className="space-y-3">
          <Textarea
            value={envText}
            spellCheck={false}
            className="min-h-24 font-mono text-xs"
            placeholder={'KEY1=VALUE1\nKEY2=VALUE2'}
            onChange={(event) => setEnvText(event.target.value)}
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">
              {hasSetting
                ? '注入到 Agent 进程的环境变量（KEY=VALUE，每行一个）。'
                : '该 Agent 尚未纳管，无法保存环境变量。'}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={!hasSetting || busy !== null}
              onClick={() => void saveEnv()}
            >
              {busy === 'env' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-3.5 w-3.5" />
              )}
              保存环境变量
            </Button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
