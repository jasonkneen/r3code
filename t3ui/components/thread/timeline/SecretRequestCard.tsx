// chat/SecretRequestCard.tsx: an agent's request for a secret. Answered, it is one line; pending, a card with a masked field,
// Save securely and Decline, sent through `secrets.answerRequest`. The typed value only ever lives in the field and the request.
import { openUrl, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { chatWidthClass } from "../layout";
import { requestBackend, serverSecretRequestReferences } from "../../../store";
import { serverSettings } from "../../../pages/settings/settingsState";
import { createAnchor, Popup } from "../../composer/Popover";
import { TimelineIcon } from "../markdown/TimelineIcon";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER, secretRequestAnswerInput, secretRequestDisplay, secretRequestFailureMessage, secretRequestInputs, secretRequestLink,
  secretRequestPrivacyNote, secretRequestReference, secretRequestSources, secretRequestValue, type SecretRequestFields, type SecretRequestReply, type SecretRequestSource,
} from "./secretRequest";

export type SecretRequestSender = (method: string, payload: unknown) => Promise<unknown>;

export function SecretRequestCard(props: { id: string; request: () => SecretRequestFields; send?: SecretRequestSender; sources?: () => SecretRequestSource[] }) {
  const display = () => secretRequestDisplay(props.request());
  const answered = () => { const current = display(); return current.kind === "answered" || current.kind === "pending-elsewhere" ? current : null; };
  const multiple = () => props.request().fields !== undefined;
  // useSecretRequestSources: configured providers (1Password) when the server accepts reference answers.
  // Multi-field cards always take typed values.
  const configuredSources = () => props.sources?.() ?? secretRequestSources(serverSecretRequestReferences(), (serverSettings() as { secretProviders?: unknown } | null)?.secretProviders);
  const sources = () => (multiple() ? [] : configuredSources());
  const sourceId = signal<string | null>(null);
  const source = () => sources().find((candidate) => candidate.id === sourceId()) ?? null;
  const reference = signal("");
  const sourceOpen = signal(false);
  const sourceAnchor = createAnchor();
  const values = signal<Record<string, string>>({});
  const revealed = signal<Record<string, boolean>>({});
  const submitting = signal(false);
  const error = signal<string | null>(null);
  const inputs = () => secretRequestInputs(props.request());
  const canSave = () =>
    source() === null
      ? secretRequestAnswerInput({ id: props.id, threadId: props.request().threadId, label: props.request().label, ...(props.request().placeholder !== undefined ? { placeholder: props.request().placeholder } : {}), ...(props.request().fields !== undefined ? { fields: props.request().fields } : {}) }, { type: "save", values: values() }) !== null
      : reference().trim().length > 0;
  const answer = async (reply: SecretRequestReply) => {
    const req = props.request();
    const input = secretRequestAnswerInput(
      { id: props.id, threadId: req.threadId, label: req.label, ...(req.placeholder !== undefined ? { placeholder: req.placeholder } : {}), ...(req.fields !== undefined ? { fields: req.fields } : {}) },
      reply,
    );
    if (input === null || submitting()) return;
    submitting.set(true);
    error.set(null);
    const typed = values();
    values.set({});
    try {
      await (props.send ?? requestBackend)("secrets.answerRequest", input);
      reference.set("");
      revealed.set({});
    } catch (cause) {
      values.set(typed);
      error.set(secretRequestFailureMessage(cause));
    } finally { submitting.set(false); }
  };
  const link = () => secretRequestLink(props.request());
  const submit = () => {
    const current = source();
    if (current === null) { void answer({ type: "save", values: values() }); return; }
    if (secretRequestReference(current, reference()) === undefined) { error.set(current.invalidReferenceMessage); return; }
    void answer({ type: "reference", source: current, reference: reference() });
  };
  return (
    <View class={`mx-auto w-full min-w-0 px-1 py-0.5 ${chatWidthClass()}`}>
      {answered() ? (
        <View class="min-h-6 flex-row items-center gap-2" accessibilityLabel="Secret request">
          <View class="size-4 items-center justify-center">
            {answered()?.kind === "pending-elsewhere" ? <TimelineIcon name="lock" size={14} /> : (answered() as { outcome?: string } | null)?.outcome === "saved" ? <TimelineIcon name="check" size={14} /> : <TimelineIcon name="minus" size={14} />}
          </View>
          <Text class="min-w-0 flex-1 truncate text-sm text-muted-foreground">{`${props.request().label} · ${answered()?.label}`}</Text>
        </View>
      ) : (
        <View class="min-w-0 gap-3 rounded-xl border border-border-60 bg-card p-4" accessibilityLabel="Secret request">
          <View class="min-w-0 gap-1">
            <Text class="text-sm font-medium text-foreground">{props.request().label}</Text>
            {props.request().reason.trim() ? <View selectable><Text class="text-sm text-muted-foreground">{props.request().reason}</Text></View> : null}
          </View>
          {link() ? (
            <View class="min-w-0 items-start gap-1.5">
              <View class="h-8 flex-row items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" onPress={() => void openUrl(link()!.href).catch(() => undefined)} accessibilityLabel={`Open ${link()!.host}`} role="button">
                <Text class="text-sm text-foreground">{`Open ${link()!.host}`}</Text>
                <TimelineIcon name="external-link" size={14} />
              </View>
              {props.request().url !== undefined ? <View selectable><Text class="font-mono text-xs text-muted-foreground">{props.request().url}</Text></View> : null}
            </View>
          ) : null}
          <View class="min-w-0 flex-row items-center gap-2">
            {sources().length > 0 ? (
              // SecretSourceSelect: "Value" (typed and stored) or a configured provider's reference.
              <View ref={sourceAnchor.ref} class="h-8 shrink-0 flex-row items-center gap-1 rounded-lg border border-input px-2 hover:bg-accent" disabled={submitting()} onPress={() => sourceOpen.update((value) => !value)} accessibilityLabel={`${props.request().label} source`} tooltip={source()?.label ?? "Value"} role="button">
                <TimelineIcon name={source() === null ? "type" : "key-round"} size={14} />
                <TimelineIcon name="chevron-down" size={12} />
              </View>
            ) : null}
            {sourceOpen() ? (
              <Popup anchor={sourceAnchor.anchor} onClose={() => sourceOpen.set(false)} placement="bottom" align="start" class="min-w-40">
                <View class="p-1">
                  {[{ id: null as string | null, label: "Value" }, ...sources().map((candidate) => ({ id: candidate.id as string | null, label: candidate.label }))].map((option) => (
                    <View class="h-8 flex-row items-center gap-2 rounded-md px-2 hover:bg-accent" onPress={() => { sourceId.set(option.id); error.set(null); sourceOpen.set(false); }} accessibilityLabel={option.label} role="button">
                      <TimelineIcon name={option.id === null ? "type" : "key-round"} size={14} />
                      <Text class="text-sm text-popover-foreground">{option.label}</Text>
                    </View>
                  ))}
                </View>
              </Popup>
            ) : null}
            <View class="min-w-0 flex-1 gap-2">
              {source() !== null ? (
                <Input
                  value={reference()}
                  placeholder={source()!.referencePlaceholder}
                  accessibilityLabel={props.request().label}
                  readonly={submitting()}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChange={(event) => { reference.set(event.value); error.set(null); }}
                  onSubmit={submit}
                  class="h-8 rounded-lg border border-input bg-background px-3 font-mono text-sm text-foreground"
                />
              ) : (
                inputs().map((input) => {
                  const isRevealed = () => revealed()[input.key] === true;
                  const mask = () => input.secret && !isRevealed();
                  return (
                    <View class="min-w-0 gap-1">
                      {multiple() ? <Text class="text-xs font-medium text-muted-foreground">{input.label}</Text> : null}
                      <View class="min-w-0 flex-row items-center gap-1 rounded-lg border border-input bg-background pr-1">
                        <Input
                          masked={mask()}
                          value={secretRequestValue(values(), input.key)}
                          placeholder={input.placeholder || SECRET_REQUEST_DEFAULT_PLACEHOLDER}
                          accessibilityLabel={input.label}
                          readonly={submitting()}
                          autoCapitalize={input.secret ? "none" : undefined}
                          autoCorrect={input.secret ? false : undefined}
                          onChange={(event) => values.update((current) => ({ ...current, [input.key]: event.value }))}
                          onSubmit={submit}
                          class="h-8 min-w-0 flex-1 bg-transparent px-3 text-sm text-foreground"
                        />
                        {input.secret ? (
                          <View
                            role="button"
                            accessibilityLabel={`${isRevealed() ? "Hide" : "Show"} ${input.label}`}
                            onPress={() => revealed.update((current) => ({ ...current, [input.key]: !current[input.key] }))}
                            class="size-6 items-center justify-center rounded-md hover:bg-accent"
                          >
                            <TimelineIcon name={isRevealed() ? "eye-off" : "eye"} size={14} />
                          </View>
                        ) : null}
                      </View>
                    </View>
                  );
                })
              )}
            </View>
            <View
              class="h-8 self-end items-center justify-center rounded-lg bg-primary px-3 active:scale-[0.97] transition-transform duration-150 ease-in-out"
              disabled={submitting() || !canSave()}
              onPress={submit}
              accessibilityLabel="Save securely"
              role="button"
            >
              <Text class="text-sm font-medium text-primary-foreground">Save securely</Text>
            </View>
          </View>
          {error() !== null ? <Text class="text-xs text-error-foreground" role="alert">{error()}</Text> : null}
          <View class="min-w-0 flex-row items-center justify-between gap-2">
            <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
              <TimelineIcon name="shield-check" size={14} />
              <Text class="min-w-0 flex-1 text-xs text-muted-foreground">{secretRequestPrivacyNote(props.request())}</Text>
            </View>
            <View class="h-7 items-center justify-center rounded-md px-2 hover:bg-accent" disabled={submitting()} onPress={() => void answer({ type: "decline" })} accessibilityLabel="Decline" role="button">
              <Text class="text-xs text-muted-foreground">Decline</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
