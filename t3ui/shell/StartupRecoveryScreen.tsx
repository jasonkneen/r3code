// app/DesktopStartupRecovery.ts's screen, without the Checking/Downloading/Update offers (updateChannel.ts: this
// build has no updater). Shown instead of the thread view while `startupRecoveryOffer()` is set: an administrator's
// managed policy this build cannot use, or the backend failing to start/connect with nothing better known than a
// prior build or the releases page. Retry re-runs the same check that raised the offer; Quit closes the window
// (quitHold.ts's own quit action, so an open SSH tunnel is still stopped).
import { Clipboard, openUrl, signal, Text, View } from "nsh";
import { closeMainWindow } from "../desktop/windowControl";
import { startupRecoveryOffer, STARTUP_RECOVERY_RELEASES_URL, type StartupRecoveryOffer } from "../desktop/startupRecovery";

function offerHeading(offer: StartupRecoveryOffer): string {
  switch (offer.kind) {
    case "managed-policy": return "Your organization's managed policy stopped R3 Code from starting.";
    case "reinstall": return "R3 Code could not start.";
    case "releases": return "R3 Code could not start.";
  }
}

function offerBody(offer: StartupRecoveryOffer): string {
  switch (offer.kind) {
    case "managed-policy": return "Send the details below to your IT administrator.";
    case "reinstall": return `Version ${offer.version} last started on this computer. Reinstalling it may fix this.`;
    case "releases": return "Visit the releases page for the latest build.";
  }
}

function Button(props: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      class={`h-8 items-center justify-center rounded-lg px-2.5 active:scale-[0.97] transition-transform duration-150 ease-in-out ${props.primary ? "bg-primary" : "border border-input bg-popover hover:bg-accent-50"}`}
    >
      <Text class={`text-sm font-medium ${props.primary ? "text-primary-foreground" : "text-foreground"}`}>{props.label}</Text>
    </View>
  );
}

function StartupRecoveryScreen(props: { offer: StartupRecoveryOffer; onRetry: () => void }) {
  const copied = signal(false);
  const offer = props.offer;
  return (
    <View class="absolute inset-0 z-50 items-center justify-center bg-background px-6 py-10" accessibilityLabel={offerHeading(offer)}>
      <View class="w-full max-w-xl rounded-2xl border border-border bg-popover p-6">
        <Text class="text-xl font-semibold leading-tight text-foreground" role="header">{offerHeading(offer)}</Text>
        <Text class="mt-2 text-sm text-muted-foreground">{offerBody(offer)}</Text>
        <View class="mt-5 flex-row flex-wrap gap-2">
          <Button label="Retry" primary onPress={props.onRetry} />
          {offer.kind === "managed-policy" ? (
            <Button
              label={copied() ? "Copied" : "Copy details"}
              onPress={() => { void Clipboard.writeText(offer.message).then(() => { copied.set(true); setTimeout(() => copied.set(false), 2000); }).catch(() => undefined); }}
            />
          ) : (
            <Button label="Open releases page" onPress={() => { void openUrl(STARTUP_RECOVERY_RELEASES_URL).catch(() => undefined); }} />
          )}
          <Button label="Quit" onPress={() => { closeMainWindow(); }} />
        </View>
        {offer.kind === "managed-policy" ? (
          <View class="mt-5 overflow-hidden rounded-lg border border-border-70 bg-background">
            <Text class="px-3 py-1.5 text-xs font-medium text-muted-foreground">Details</Text>
            <View class="border-t border-border-70 px-3 py-2"><View selectable><Text class="text-xs text-foreground">{offer.message}</Text></View></View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Mounted once at the app's root, beside the thread view: renders only while an offer is set. */
export function StartupRecoveryHost(props: { onRetry: () => void }) {
  const offer = () => startupRecoveryOffer();
  return offer() ? <StartupRecoveryScreen offer={offer()!} onRetry={props.onRetry} /> : null;
}

export { offerHeading, offerBody };
