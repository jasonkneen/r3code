// The app shell: the sidebar and the chat pane side by side, with the ⌘K
// palette over both when it is up, and settings or usage replacing the chat pane.
import { noteUserInput } from "./components/userActivity";
import { prewarmShikiLanguages } from "./components/thread/markdown/shikiHighlight";
import { clearHeldModifiers, noteHeldModifiers } from "./components/sidebar/jumpHints";
import { effect, keymap, lifecycle, mount, platform, View } from "nsh";
import { flushPendingDraftSave, openThread, usageOpen } from "./store";
import { startThreadOverlayRetention } from "./components/thread/threadOverlayRetention";
import { Window } from "nsh/desktop";
import { isDeclarativeWindow, setMainWindowFrame, setMainWindowTitle, setMainWindowTitleBar } from "./desktop/windowControl";
import { installKeybindings } from "./commands/registry";
import { installSnapShotShortcut } from "./commands/snapShotShortcut";
import { installStandardCommands, toggleSettings } from "./commands/standardCommands";
import { startI18n } from "./i18n/runtime";
import { CommandPalette } from "./components/CommandPalette";
import { Sidebar } from "./components/Sidebar";
import { SidebarAddProject } from "./components/SidebarAddProject";
import { ShellOverlays } from "./shell/ShellOverlays";
import { installKeybindingsToasts } from "./shell/keybindingsToast";
import { installApplicationMenu } from "./shell/quitHold";
import { startBackgroundUpdateChecks } from "./desktop/updateCheck";
import { RootErrorBoundary } from "./shell/RootErrorView";
import { installPullRequestsEscape, installThreadSelectionEscape } from "./shell/windowBehaviours";
import { installRootCoordinators } from "./components/coordinators/installCoordinators";
import { installForcedRecordingIfFlagged } from "./components/composer/forcedRecording";
import { installEnvironmentConnections } from "./environments/install";
import { AddProjectToMachineDialogHost } from "./environments/AddProjectToMachineDialog";
import { RelayClientInstallDialogHost } from "./environments/RelayClientInstallDialog";
import { SshPasswordPromptDialogHost } from "./desktop/SshPasswordPromptDialog";
import { ConnectSignInDialogHost } from "./cloud/ConnectSignIn";
import { ConnectOnboardingDialogHost } from "./cloud/ConnectOnboardingDialog";
import { AccountPagesDialogHost } from "./cloud/AccountPages";
import { StandalonePagesHost } from "./environments/StandalonePages";
import { ChatGptWelcomeHost } from "./pages/settings/providers/ChatGptWelcome";
import { FirstRunGate } from "./components/onboarding/FirstRunGate";
import { NewThreadLinkHost } from "./desktop/NewThreadLinkPage";
import { prefetchIcons } from "./components/Icons";
import { HEADER_ICONS } from "./components/header/HeaderIcons";
import { Settings } from "./pages/Settings";
import { Issues } from "./pages/Issues";
import { PullRequests } from "./pages/PullRequests";
import { Usage } from "./pages/Usage";
import { ThreadView } from "./pages/ThreadView";
import { settledLayout } from "./components/composer/editor/PromptEditor";
import { initializeBackend, settingsOpen, sidebarOpen, utilityPage } from "./store";
import { rootTextStyle } from "./typography";
import { StartupRecoveryHost } from "./shell/StartupRecoveryScreen";
import { clearStartupRecovery, startupRecoveryOffer } from "./desktop/startupRecovery";
import { retryManagedPolicyCheck } from "./desktop/managedPolicy";
import { requestRelaunch } from "./desktop/relaunchRequest";
import { showToast } from "./components/toast/toastState";
// Importing the files registers the family before the first frame; theme.json names it as `font-sans`.
// They are fixed-weight cuts (tools/gen_interface_font.py): the host paints a variable font at its
// default instance, which for Bricolage Grotesque is ExtraBold.
import "./fonts/BricolageGroteskUI-Regular.ttf";
import "./fonts/BricolageGroteskUI-Medium.ttf";
import "./fonts/BricolageGroteskUI-SemiBold.ttf";
import "./fonts/BricolageGroteskUI-Bold.ttf";

// Every keybinding command (mod+k, mod+b, mod+u, mod+shift+n, thread navigation, panel
// toggles ...) runs through the command registry, bound from the resolved server
// keybindings, so a saved override re-binds it live. Only `mod+,` stays fixed: it is the
// desktop menu's Settings item, not a keybinding command.
installStandardCommands();
installKeybindings();
startI18n();
// composerDraftStore.ts flushes pending draft writes on unload; here when the app leaves the foreground.
effect(() => { if (lifecycle() !== "active") flushPendingDraftSave(); });
keymap.bind({ "mod+,": toggleSettings });
installApplicationMenu();
// Check-only updater (desktop/updateCheck.ts): GitHub releases, no download/install. Startup + daily; silent
// unless a newer release is found.
startBackgroundUpdateChecks();
installKeybindingsToasts();
installPullRequestsEscape();
installThreadSelectionEscape();
installRootCoordinators();
// appInit.tsx startThreadOverlayRetention: leaving a thread (or opening settings, usage or a utility page, routes in the
// reference) drops its overlays.
startThreadOverlayRetention(() => (utilityPage() || settingsOpen() || usageOpen() ? null : openThread()?.id ?? null));
// Dev check: `<dataDir>/voice/force-recording` holds the composer in its recording phase (components/composer/forcedRecording.ts).
void installForcedRecordingIfFlagged();
installSnapShotShortcut();

/** StartupRecoveryScreen's Retry. A managed-policy offer can be re-checked in place (an administrator may have
 * just fixed the profile or file); the backend ones (reinstall/releases) came from the local bootstrap's one-time
 * handshake failing, which cannot be retried in place, so the only retry is a full window relaunch. */
function retryStartup() {
  const offer = startupRecoveryOffer();
  if (!offer) return;
  if (offer.kind === "managed-policy") { retryManagedPolicyCheck(); return; }
  void requestRelaunch("startup-recovery-retry").then((requested) => {
    if (requested) clearStartupRecovery();
    else showToast({ title: "Quit and reopen R3 Code to retry" });
  }).catch(() => {
    showToast({ type: "error", title: "Could not restart R3 Code", description: "Quit and reopen the app to retry." });
  });
}

function App() {
  // Opening a utility page takes the thread view (and a focused composer) out: the switch waits for the editor to give
  // the keyboard up, or its key bindings outlive it (components/composer/editor/PromptEditor.tsx).
  const utilityPageShown = settledLayout(() => utilityPage() !== null);
  return (
    <View class="relative flex-1 flex-row bg-background" style={rootTextStyle() as any} onMouseMove={(event) => { noteUserInput(); noteHeldModifiers(event.modifiers); }} onMouseLeave={clearHeldModifiers}>
      <RootErrorBoundary>
        {sidebarOpen() ? <Sidebar /> : null}
        {utilityPageShown() ? (utilityPage() === "issues" ? <Issues /> : <PullRequests />) : <ThreadView />}
        {settingsOpen() ? <Settings /> : null}
        <Usage />
        <CommandPalette />
        <SidebarAddProject />
        <FirstRunGate />
        <NewThreadLinkHost />
        <AddProjectToMachineDialogHost />
        <RelayClientInstallDialogHost />
        <SshPasswordPromptDialogHost />
        <ConnectSignInDialogHost />
        <ConnectOnboardingDialogHost />
        <AccountPagesDialogHost />
        <StandalonePagesHost />
        <ChatGptWelcomeHost />
      </RootErrorBoundary>
      <StartupRecoveryHost onRetry={retryStartup} />
      <ShellOverlays />
    </View>
  );
}

if (!isDeclarativeWindow()) {
  setMainWindowTitle("R3 Code");
  // The web desktop shell has no system title bar: the sidebar's blueprint header and the
  // thread header reach the window's top edge, with the traffic lights centred in that 52pt band.
  setMainWindowTitleBar({ style: "hidden", height: 52 });
}
// Test copies only (tools/run_local.py forwards it): "x,y" in screen points places the window, so an agent's test
// window can sit clear of the windows covering it (a fully covered window takes no posted clicks or keys).
try {
  const testOrigin = (process.env.T3GPUI_TEST_WINDOW_ORIGIN ?? "").split(",").map(Number);
  if (testOrigin.length === 2 && testOrigin.every(Number.isFinite)) setTimeout(() => setMainWindowFrame({ origin: { x: testOrigin[0], y: testOrigin[1] } }), 1500);
} catch { /* not allowed to read it: leave the window where the system put it */ }
void prefetchIcons(HEADER_ICONS);
void initializeBackend();
installEnvironmentConnections();
// Shiki grammars for the common languages build at the first idle moment (shikiHighlight.ts), not on the first block.
if (platform.os !== "windows") prewarmShikiLanguages();
if (isDeclarativeWindow()) {
  const NativeWindow = Window as unknown as (props: Record<string, unknown>) => any;
  mount(() => (
    <NativeWindow
      id="main"
      title="R3 Code"
      titleBar={{ style: "hidden", height: 52 }}
      defaultSize={{ width: 1280, height: 840 }}
      minSize={{ width: 400, height: 360 }}
      restoreBounds={true}
    >
      <App />
    </NativeWindow>
  ));
} else {
  mount(App);
}
