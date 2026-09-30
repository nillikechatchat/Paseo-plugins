// Modal-style form for creating / editing a provider. Uses Paseo Modal so we
// don't fight the host's chrome.

import React, { useEffect, useMemo, useState } from "react";
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  PROVIDER_TYPE_DEFAULT_BASE,
  PROVIDER_TYPE_LABELS,
  type ProviderRecord,
  type ProviderType,
} from "./types";
import { fetchProviderModelsList } from "../../shared/rpc";

interface Props {
  open: boolean;
  initial: ProviderRecord | null;
  theme: PluginTheme;
  onClose: () => void;
  onSubmit: (provider: Omit<ProviderRecord, "createdAt" | "updatedAt">) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

const TYPE_KEYS: ProviderType[] = [
  "openai",
  "openai-compatible",
  "azure-openai",
  "anthropic",
  "google",
  "ollama",
  "zhipu",
  "volcengine",
];

export function ProviderEdit({ open, initial, theme, onClose, onSubmit, onDelete }: Props) {
  const toast = useToast();
  const [type, setType] = useState<ProviderType>(initial?.type ?? "openai");
  const [name, setName] = useState(initial?.name ?? "");
  const [id, setId] = useState(initial?.id ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [models, setModels] = useState((initial?.models ?? []).join("\n"));
  const [priority, setPriority] = useState(String(initial?.priority ?? 0));
  const [weight, setWeight] = useState(String(initial?.weight ?? 100));
  const [rateLimit, setRateLimit] = useState(String(initial?.rateLimitRpm ?? 0));
  const [timeout, setTimeout] = useState(String(initial?.timeoutMs ?? 120_000));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    initial?.maxOutputTokens != null ? String(initial.maxOutputTokens) : "",
  );
  const [contextWindow, setContextWindow] = useState(
    initial?.contextWindow != null ? String(initial.contextWindow) : "",
  );
  const [exposeMessages, setExposeMessages] = useState(initial?.exposeMessages === true);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const callFetchModels = useRpc(fetchProviderModelsList);

  // The modal stays mounted across open/close, so the useState initializers
  // above only fire once. Re-sync every field whenever a different provider
  // is loaded for editing — otherwise editing provider B right after A shows
  // A's values.
  useEffect(() => {
    if (!open) return;
    setType(initial?.type ?? "openai");
    setName(initial?.name ?? "");
    setId(initial?.id ?? "");
    setBaseUrl(initial?.baseUrl ?? "");
    setApiKey(initial?.apiKey ?? "");
    setModels((initial?.models ?? []).join("\n"));
    setPriority(String(initial?.priority ?? 0));
    setWeight(String(initial?.weight ?? 100));
    setRateLimit(String(initial?.rateLimitRpm ?? 0));
    setTimeout(String(initial?.timeoutMs ?? 120_000));
    setEnabled(initial?.enabled ?? true);
    setNotes(initial?.notes ?? "");
    setMaxOutputTokens(initial?.maxOutputTokens != null ? String(initial.maxOutputTokens) : "");
    setContextWindow(initial?.contextWindow != null ? String(initial.contextWindow) : "");
    setExposeMessages(initial?.exposeMessages === true);
  }, [open, initial]);

  const styles = useMemo(() => makeStyles(theme), [theme]);
  const isEdit = !!initial;

  const typeHint = useMemo(() => {
    const def = PROVIDER_TYPE_DEFAULT_BASE[type];
    if (def) return `默认：${def}`;
    if (type === "azure-openai") return "请填写 Azure OpenAI endpoint（不含部署名）";
    return "可留空，按 Provider 类型使用默认地址";
  }, [type]);

  async function handleFetchModels() {
    if (!type) {
      toast.error("请先选择服务商类型");
      return;
    }
    setFetching(true);
    try {
      const r = await callFetchModels({
        type,
        name: name.trim() || "draft",
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        models: models.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
        priority: parseInt(priority, 10) || 0,
        weight: Math.max(1, Math.min(1000, parseInt(weight, 10) || 100)),
        enabled,
        rateLimitRpm: Math.max(0, parseInt(rateLimit, 10) || 0),
        timeoutMs: Math.max(1000, Math.min(600_000, parseInt(timeout, 10) || 120_000)),
        notes: notes.trim() || undefined,
        maxOutputTokens: parseInt(maxOutputTokens, 10) || undefined,
        contextWindow: parseInt(contextWindow, 10) || undefined,
        exposeMessages: exposeMessages,
      });
      if (r.models.length === 0) {
        toast.show("上游没有返回模型，请检查 baseUrl / apiKey", { variant: "warning", durationMs: 4000 });
      } else {
        const merged = Array.from(new Set([...models.split(/[\n,]/).map((s) => s.trim()).filter(Boolean), ...r.models]));
        setModels(merged.join("\n"));
        toast.show(`已获取 ${r.models.length} 个模型`, { variant: "success", durationMs: 3000 });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  }

  async function handleSubmit() {
    setBusy(true);
    try {
      const finalId = (isEdit ? id : (id || slugify(name) || cryptoId())).trim();
      if (!finalId) throw new Error("缺少 ID");
      if (!name.trim()) throw new Error("缺少名称");
      const modelList = models.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      await onSubmit({
        id: finalId,
        name: name.trim(),
        type,
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        models: modelList,
        priority: parseInt(priority, 10) || 0,
        weight: Math.max(1, Math.min(1000, parseInt(weight, 10) || 100)),
        enabled,
        rateLimitRpm: Math.max(0, parseInt(rateLimit, 10) || 0),
        timeoutMs: Math.max(1000, Math.min(600_000, parseInt(timeout, 10) || 120_000)),
        notes: notes.trim() || undefined,
        maxOutputTokens: parseInt(maxOutputTokens, 10) || undefined,
        contextWindow: parseInt(contextWindow, 10) || undefined,
        exposeMessages: exposeMessages,
      });
      toast.show("服务商已保存", { variant: "success" });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!initial || !onDelete) return;
    setBusy(true);
    try {
      await onDelete(initial.id);
      toast.show("已删除", { variant: "success" });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={isEdit ? `编辑 ${initial?.name ?? ""}` : "新增服务商"} open={open} onOpenChange={(v) => !v && onClose()}>
      <Modal.Content>
        <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
          <Field theme={theme} label="类型">
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {TYPE_KEYS.map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setType(t)}
                  style={[
                    styles.chip,
                    type === t ? styles.chipActive : null,
                  ]}
                >
                  <Text style={type === t ? styles.chipTextActive : styles.chipText}>
                    {PROVIDER_TYPE_LABELS[t]}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Field>
          <Field theme={theme} label="ID（不可重复）">
            <TextInput
              editable={!isEdit}
              value={id}
              onChangeText={setId}
              placeholder="例如：openai-prod"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
          </Field>
          <Field theme={theme} label="名称">
            <TextInput value={name} onChangeText={setName} placeholder="显示名" placeholderTextColor={theme.colors.foregroundMuted} style={styles.input} />
          </Field>
          <Field theme={theme} label="Base URL">
            <TextInput value={baseUrl} onChangeText={setBaseUrl} placeholder={typeHint} placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
            <Text style={styles.hint}>{typeHint}</Text>
          </Field>
          <Field theme={theme} label="API Key">
            <TextInput value={apiKey} onChangeText={setApiKey} placeholder="sk-..." placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} secureTextEntry style={styles.input} />
          </Field>
          <Field theme={theme} label="模型（每行一个，逗号分隔）">
            <TextInput
              value={models}
              onChangeText={setModels}
              placeholder={"gpt-4o\ngpt-4o-mini"}
              placeholderTextColor={theme.colors.foregroundMuted}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
            />
            <Pressable
              disabled={fetching || busy}
              onPress={handleFetchModels}
              style={[
                styles.fetchBtn,
                { borderColor: theme.colors.accent, opacity: fetching || busy ? 0.5 : 1 },
              ]}
            >
              {fetching ? (
                <ActivityIndicator color={theme.colors.accent} />
              ) : (
                <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const }}>
                  ↻ 从上游接口获取
                </Text>
              )}
            </Pressable>
          </Field>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Field theme={theme} label="优先级" flex={1}>
              <TextInput value={priority} onChangeText={setPriority} keyboardType="number-pad" placeholder="0" placeholderTextColor={theme.colors.foregroundMuted} style={styles.input} />
            </Field>
            <Field theme={theme} label="权重" flex={1}>
              <TextInput value={weight} onChangeText={setWeight} keyboardType="number-pad" placeholder="100" placeholderTextColor={theme.colors.foregroundMuted} style={styles.input} />
            </Field>
          </View>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Field theme={theme} label="限速 (RPM)" flex={1}>
              <TextInput value={rateLimit} onChangeText={setRateLimit} keyboardType="number-pad" placeholder="0=不限" placeholderTextColor={theme.colors.foregroundMuted} style={styles.input} />
            </Field>
            <Field theme={theme} label="超时 (ms)" flex={1}>
              <TextInput value={timeout} onChangeText={setTimeout} keyboardType="number-pad" placeholder="120000" placeholderTextColor={theme.colors.foregroundMuted} style={styles.input} />
            </Field>
          </View>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Field theme={theme} label="输出上限 (tokens)" flex={1}>
              <TextInput value={maxOutputTokens} onChangeText={setMaxOutputTokens} keyboardType="number-pad" placeholder="空=默认" placeholderTextColor={theme.colors.foregroundMuted} style={styles.input} />
              <Text style={styles.hint}>Responses 请求 max_output_tokens 保底值（严格上游如 Agnes 默认 4096 会截断长思考）</Text>
            </Field>
            <Field theme={theme} label="上下文窗口 (tokens)" flex={1}>
              <TextInput value={contextWindow} onChangeText={setContextWindow} keyboardType="number-pad" placeholder="空=不预检" placeholderTextColor={theme.colors.foregroundMuted} style={styles.input} />
              <Text style={styles.hint}>超限请求提前返回 413，不再打上游</Text>
            </Field>
          </View>
          <Field theme={theme} label="备注">
            <TextInput value={notes} onChangeText={setNotes} placeholder="可选" placeholderTextColor={theme.colors.foregroundMuted} style={styles.input} />
          </Field>
          <Pressable onPress={() => setEnabled(!enabled)} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <View style={[styles.checkbox, { backgroundColor: enabled ? theme.colors.accent : "transparent" }]} />
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>启用此 Provider</Text>
          </Pressable>
          <Pressable onPress={() => setExposeMessages(!exposeMessages)} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <View style={[styles.checkbox, { backgroundColor: exposeMessages ? theme.colors.accent : "transparent" }]} />
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>暴露到 Claude Code（/v1/messages）</Text>
          </Pressable>
          <Text style={styles.hint}>
            非 anthropic 类型的服务商，若自身也提供 /v1/messages（如 Agnes），勾选后其模型会出现在 Claude Code 可选项中
          </Text>

          <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
            <Pressable
              disabled={busy}
              onPress={handleSubmit}
              style={[styles.primaryBtn, { backgroundColor: busy ? theme.colors.surface2 : theme.colors.accent }]}
            >
              {busy ? <ActivityIndicator color={theme.colors.accentForeground} /> : <Text style={{ color: theme.colors.accentForeground, fontWeight: "600" }}>{isEdit ? "保存" : "新增"}</Text>}
            </Pressable>
            {isEdit && onDelete && (
              <Pressable
                disabled={busy}
                onPress={handleDelete}
                style={[styles.dangerBtn, { borderColor: theme.colors.statusDanger }]}
              >
                <Text style={{ color: theme.colors.statusDanger, fontWeight: "600" }}>删除</Text>
              </Pressable>
            )}
            <Pressable onPress={onClose} style={[styles.ghostBtn, { borderColor: theme.colors.border }]}>
              <Text style={{ color: theme.colors.foreground }}>取消</Text>
            </Pressable>
          </View>
        </ScrollView>
      </Modal.Content>
    </Modal>
  );
}

function makeStyles(theme: PluginTheme) {
  return {
    chip: {
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    chipActive: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    chipText: { fontSize: 12, color: theme.colors.foreground },
    chipTextActive: { fontSize: 12, color: theme.colors.accentForeground, fontWeight: "600" as const },
    input: {
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      color: theme.colors.foreground,
      fontSize: 13,
      backgroundColor: theme.colors.surface1,
    },
    hint: { fontSize: 11, color: theme.colors.foregroundMuted, marginTop: 4 },
    checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: theme.colors.border },
    primaryBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center" as const },
    dangerBtn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1 },
    ghostBtn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1 },
    fetchBtn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, alignItems: "center" as const, marginTop: 6 },
  };
}

function Field({ label, children, flex, theme }: { label: string; children: React.ReactNode; flex?: number; theme: PluginTheme }) {
  return (
    <View style={[{ gap: 4 }, flex ? { flex } : null]}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const, textTransform: "uppercase" as const }}>{label}</Text>
      {children}
    </View>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10);
}
