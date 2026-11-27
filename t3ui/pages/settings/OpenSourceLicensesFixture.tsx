import { mount, signal, Text, View } from "nsh";
import { SettingsPageContainer } from "../../components/SettingsLayout";
import { configureLicenseLoader, configureNativeLicenseLoader, OpenSourceLicenses } from "./OpenSourceLicenses";
import { decodeThirdPartyLicenseManifest } from "./licensesLogic";

const manifest = decodeThirdPartyLicenseManifest({
  schemaVersion: 1,
  entries: [
    { bundles: ["web", "desktop"], kind: "package", license: "MIT", name: "react", noticeText: "MIT License\n\nCopyright (c) Meta Platforms", sourceUrl: "https://github.com/facebook/react", version: "19.0.0" },
    { bundles: ["server"], kind: "package", license: "Apache-2.0", name: "effect", noticeText: "Apache License text for effect", sourceUrl: null, version: "4.0.0" },
    { bundles: ["assets"], kind: "custom", license: "CC0-1.0", name: "Notification Sound 1", noticeText: "Public domain dedication", sourceUrl: null, version: null },
  ],
});
const attempts = signal(0);
const failure = signal<string | null>("The license manifest request failed with status 404.");
const externalNativeMode = signal(false);

configureLicenseLoader(async () => {
  attempts.update((n) => n + 1);
  if (failure() !== null) throw new Error(failure()!);
  return manifest;
});

function enableExternalNativeTestMode() {
  let nativeAttempt = 0;
  configureNativeLicenseLoader(async () => {
    nativeAttempt += 1;
    if (nativeAttempt === 1) {
      return { texts: ["MIT"], packages: [{ name: "broken", version: "1.0.0", license: "MIT", sourceUrl: null, texts: [99] }] };
    }
    return {
      texts: ["Copyright Example"],
      packages: [{ name: "sample-crate", version: "0.2.0", license: "MIT", sourceUrl: null, texts: [0] }],
    };
  });
  externalNativeMode.set(true);
}

mount(() => (
  <View class="flex-1">
    <View accessibilityLabel="Server recovers" onPress={() => failure.set(null)}><Text>Server recovers</Text></View>
    <View accessibilityLabel="Enable external native loader" onPress={enableExternalNativeTestMode}><Text>Enable external native loader</Text></View>
    <Text>{`loads ${attempts()}`}</Text>
    <SettingsPageContainer>{() => (externalNativeMode() ? <OpenSourceLicenses /> : <OpenSourceLicenses />)}</SettingsPageContainer>
  </View>
));
