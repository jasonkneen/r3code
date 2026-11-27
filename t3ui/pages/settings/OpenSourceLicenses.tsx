// The Open source licenses page, ported from components/settings/OpenSourceLicenses.tsx: the server's
// third-party notice manifest, one collapsible entry per notice with its license text and a link to
// the project, searchable by every word, with the web's loading, empty and failure states.
import { effect, host, openUrl, platform, signal, Text, token, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { Icon } from "../../components/Icons";
import { tokenAlpha } from "../../components/composer/tokenColor";
import { ChevronTurn } from "../../components/motion/Motion";
import { SettingsButton, SettingsSection } from "../../components/SettingsLayout";
import { SettingsIcon } from "./SettingsIcon";
import { backendUrl } from "../../store";
import { R3_LICENSE_TEXT } from "./r3LicenseText";
import { GPUI_FAST_LICENSE_TEXT, NSH_LICENSE_TEXT } from "./nativeLicenseTexts";
import { nativeLicenseData } from "./nativeDependencyNotices";
import { PYTHON_LICENSE_TEXT } from "./pythonLicenseText";
import {
  filterThirdPartyLicenseEntries, formatLicenseBundles, LICENSE_FALLBACK_MESSAGE, licenseCountLabel, licenseManifestUrl, loadLicenseManifest,
  thirdPartyLicenseEntryKey, type ThirdPartyLicenseEntry, type ThirdPartyLicenseManifest,
} from "./licensesLogic";

const T3_NOTICE: ThirdPartyLicenseEntry = {
  name: "T3 Code", version: null, license: "MIT", kind: "custom", bundles: ["upstream"],
  sourceUrl: "https://github.com/pingdotgg/t3code",
  noticeText: `MIT License\n\nCopyright (c) 2026 T3 Tools Inc.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
};
const R3_NOTICE: ThirdPartyLicenseEntry = {
  name: "R3 Code original code", version: null, license: "AGPL-3.0-only", kind: "custom", bundles: ["R3"],
  sourceUrl: "https://www.gnu.org/licenses/agpl-3.0.html", noticeText: R3_LICENSE_TEXT,
};
const NSH_NOTICE: ThirdPartyLicenseEntry = {
  name: "NSH", version: null, license: "Apache-2.0", kind: "custom", bundles: ["native host"],
  sourceUrl: "https://github.com/longbridge/nsh", noticeText: NSH_LICENSE_TEXT,
};
const GPUI_FAST_NOTICE: ThirdPartyLicenseEntry = {
  name: "GPUI Fast", version: "0.1.9", license: "Apache-2.0", kind: "custom", bundles: ["native host"],
  sourceUrl: "https://github.com/longbridge/gpui-fast", noticeText: GPUI_FAST_LICENSE_TEXT,
};
const PYTHON_NOTICE: ThirdPartyLicenseEntry = {
  name: "CPython", version: "3.11.18", license: "Python-2.0", kind: "custom", bundles: ["theme helper"],
  sourceUrl: "https://github.com/python/cpython", noticeText: PYTHON_LICENSE_TEXT,
};

export interface NativeLicensePayload {
  texts: string[];
  packages: { name: string; version: string; license: string; sourceUrl: string | null; texts: number[] }[];
  external?: boolean;
  packageCount?: number;
}

const bundledNativeData = nativeLicenseData as NativeLicensePayload;
let nativeLicenseLoaderOverride: (() => Promise<NativeLicensePayload>) | null = null;
export function configureNativeLicenseLoader(next: (() => Promise<NativeLicensePayload>) | null) {
  nativeLicenseLoaderOverride = next;
}

function toNativeEntries(data: NativeLicensePayload): ThirdPartyLicenseEntry[] {
  if (!data || typeof data !== "object" || !Array.isArray(data.texts) || !Array.isArray(data.packages)) {
    throw new Error("Native dependency notices have an invalid format.");
  }
  return data.packages.map((item) => {
    if (
      !item
      || typeof item !== "object"
      || typeof item.name !== "string"
      || typeof item.version !== "string"
      || typeof item.license !== "string"
      || (item.sourceUrl !== null && typeof item.sourceUrl !== "string")
      || !Array.isArray(item.texts)
    ) {
      throw new Error("Native dependency notices contain a malformed package entry.");
    }
    const noticeParts = item.texts.map((index) => {
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= data.texts.length || typeof data.texts[index] !== "string") {
        throw new Error("Native dependency notices contain an invalid text reference.");
      }
      return data.texts[index]!;
    });
    return {
      name: item.name,
      version: item.version,
      license: item.license,
      kind: "package",
      bundles: ["native host"],
      sourceUrl: item.sourceUrl,
      noticeText: noticeParts.join("\n\n"),
    };
  });
}

async function fetchExternalNativeLicenses(): Promise<NativeLicensePayload> {
  if (nativeLicenseLoaderOverride) return nativeLicenseLoaderOverride();
  if (platform.os === "windows" && host.available()) {
    const raw = await host.call("r3.readNativeLicenses", {}, { timeout: 5000 });
    if (raw && typeof raw === "object" && Array.isArray((raw as NativeLicensePayload).texts) && Array.isArray((raw as NativeLicensePayload).packages)) {
      return raw as NativeLicensePayload;
    }
    throw new Error("Native dependency notices have an invalid format.");
  }
  throw new Error("Native dependency notices are unavailable.");
}

/** Tests replace the transport; the app loads from the connected server. */
let loader: () => Promise<ThirdPartyLicenseManifest> = () => {
  const url = licenseManifestUrl(backendUrl());
  return url ? loadLicenseManifest(url) : Promise.reject(new Error(LICENSE_FALLBACK_MESSAGE));
};
export function configureLicenseLoader(next: () => Promise<ThirdPartyLicenseManifest>) { loader = next; }

function Count(props: { filtered: () => number; total: () => number }) {
  return <Text class="text-xs font-normal text-muted-foreground">{licenseCountLabel(props.filtered(), props.total())}</Text>;
}

function NoticeRow(props: { entry: ThirdPartyLicenseEntry; open: () => boolean; toggle: () => void }) {
  const entry = props.entry;
  return (
    <View testID={`License ${entry.name} (${props.open() ? "open" : "closed"})`}>
      <View class="min-h-9 flex-row items-center hover:bg-accent-50">
        <View role="button" accessibilityLabel={`${entry.name} license notice`} accessibilityState={{ expanded: props.open() }} class="min-h-9 min-w-0 flex-1 flex-row items-center gap-2.5 px-4" onPress={props.toggle}>
          <ChevronTurn open={props.open} degrees={90}><Icon name="chevron-right" size={14} tint={token("muted-foreground")} /></ChevronTurn>
          <View class="min-w-0 flex-1 flex-row items-baseline gap-2">
            <Text class="shrink font-medium text-foreground truncate">{entry.name}</Text>
            {entry.version ? <Text class="shrink-0 font-mono text-xs text-muted-foreground">{entry.version}</Text> : null}
          </View>
          <Text class="max-w-[42%] shrink-0 text-xs text-muted-foreground truncate">{`${entry.license} · ${formatLicenseBundles(entry.bundles)}`}</Text>
        </View>
        {entry.sourceUrl ? (
          <View
            role="button"
            accessibilityLabel={`View project source for ${entry.name}`}
            class="mr-4 size-5 shrink-0 items-center justify-center rounded-md hover:bg-accent"
            onPress={() => void openUrl(entry.sourceUrl!).catch(() => undefined)}
          >
            <SettingsIcon name="external-link" size={12} tint={token("muted-foreground")} />
          </View>
        ) : null}
      </View>
      {props.open() ? (
        <View class="px-10 pt-1 pb-4">
          {/* NSH does not resolve the `ch` unit, so the reference's `max-w-[76ch]` (monospace, text-xs) is
              converted to the pixel width it resolves to: 76 * 0.6em * 12px. */}
          <Text class="max-w-[547px] font-mono text-xs" style={{ color: tokenAlpha("foreground", 0.8) }}>{entry.noticeText}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function OpenSourceLicenses() {
  const manifest = signal<ThirdPartyLicenseManifest | null>(null);
  const error = signal<string | null>(null);
  const query = signal("");
  const searchOpen = signal(false);
  const openKey = signal<string | null>(null);
  const nativeOpen = signal(false);
  const nativeQuery = signal("");
  const nativeLimit = signal(40);
  const nativeExternal = Boolean(bundledNativeData.external) || nativeLicenseLoaderOverride !== null;
  const nativeTotalCount = signal(
    typeof bundledNativeData.packageCount === "number" ? bundledNativeData.packageCount : bundledNativeData.packages.length,
  );
  const loadedNativeEntries = signal<ThirdPartyLicenseEntry[] | null>(null);
  const nativeLoading = signal(false);
  const nativeError = signal<string | null>(null);
  let nativeSerial = 0;
  const loadNative = () => {
    if (!nativeExternal || loadedNativeEntries() !== null || nativeLoading()) return;
    const mine = ++nativeSerial;
    nativeLoading.set(true);
    nativeError.set(null);
    void fetchExternalNativeLicenses()
      .then((data) => {
        if (mine !== nativeSerial) return;
        const entries = toNativeEntries(data);
        loadedNativeEntries.set(entries);
        nativeTotalCount.set(entries.length);
        nativeLoading.set(false);
      })
      .catch((cause) => {
        if (mine !== nativeSerial) return;
        nativeLoading.set(false);
        nativeError.set(cause instanceof Error && cause.message ? cause.message : "Could not load native dependency notices.");
      });
  };
  let cachedBundledNativeEntries: ThirdPartyLicenseEntry[] | null = null;
  const nativeEntries = () => {
    if (!nativeOpen()) return [];
    if (nativeExternal) return loadedNativeEntries() ?? [];
    if (!cachedBundledNativeEntries) {
      cachedBundledNativeEntries = toNativeEntries(bundledNativeData);
    }
    return cachedBundledNativeEntries;
  };
  const matchingNative = () => filterThirdPartyLicenseEntries(nativeEntries(), nativeQuery());
  let serial = 0;
  const load = () => {
    const mine = ++serial;
    error.set(null);
    manifest.set(null);
    loader().then(
      (value) => { if (mine === serial) manifest.set(value); },
      (cause) => { if (mine === serial) error.set(cause instanceof Error && cause.message ? cause.message : LICENSE_FALLBACK_MESSAGE); },
    );
  };
  // Not kept: a failed load does not stick, each visit loads the manifest again.
  effect(() => { untracked(load); });
  const entries = () => manifest()?.entries ?? [];
  const filtered = () => filterThirdPartyLicenseEntries(entries(), query());
  const headerAction = () => {
    if (!manifest()) return null;
    if (!searchOpen()) {
      return (
        <View class="flex-row items-center gap-1.5">
          <Count filtered={() => filtered().length} total={() => entries().length} />
          <View role="button" accessibilityLabel="Search open-source licenses" class="size-5 items-center justify-center rounded-md hover:bg-accent" onPress={() => searchOpen.set(true)}>
            <Icon name="search" size={12} tint={token("muted-foreground")} />
          </View>
        </View>
      );
    }
    return (
      <View class="flex-row items-center gap-2">
        <Count filtered={() => filtered().length} total={() => entries().length} />
        <View class="h-7 w-44 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-2">
          <Icon name="search" size={12} tint={token("muted-foreground")} />
          <Input
            accessibilityLabel="Search open-source licenses"
            value={query()}
            placeholder="Search licenses"
            autoFocus
            onChange={(event) => query.set(event.value)}
            onBlur={() => { if (query().length === 0) searchOpen.set(false); }}
            class="min-w-0 flex-1 bg-transparent text-xs text-foreground"
          />
        </View>
      </View>
    );
  };
  return (
    <>
    <SettingsSection title="R3 Code">
      <View class="gap-2 px-4 py-4">
        <Text class="text-sm text-foreground">R3 Code's original code: GNU Affero General Public License, version 3 only (AGPL-3.0-only).</Text>
        <Text class="text-sm text-muted-foreground">T3 Code-derived material keeps its MIT license; COMPONENT-LICENSES.md lists the files. Third-party components retain their notices.</Text>
      </View>
      <NoticeRow entry={R3_NOTICE} open={() => openKey() === "r3-original"} toggle={() => openKey.set(openKey() === "r3-original" ? null : "r3-original")} />
    </SettingsSection>
    <SettingsSection title="T3 Code">
      <NoticeRow entry={T3_NOTICE} open={() => openKey() === "t3-upstream"} toggle={() => openKey.set(openKey() === "t3-upstream" ? null : "t3-upstream")} />
    </SettingsSection>
    <SettingsSection title="Native host">
      <NoticeRow entry={NSH_NOTICE} open={() => openKey() === "nsh-native"} toggle={() => openKey.set(openKey() === "nsh-native" ? null : "nsh-native")} />
      <NoticeRow entry={GPUI_FAST_NOTICE} open={() => openKey() === "gpui-native"} toggle={() => openKey.set(openKey() === "gpui-native" ? null : "gpui-native")} />
      <NoticeRow entry={PYTHON_NOTICE} open={() => openKey() === "python-runtime"} toggle={() => openKey.set(openKey() === "python-runtime" ? null : "python-runtime")} />
      <View class="items-start gap-3 px-4 py-4">
        <Text class="text-xs text-muted-foreground">Native dependency notices generated for the macOS Apple silicon host.</Text>
        <SettingsButton
          label={nativeOpen() ? "Hide native dependencies" : `View ${nativeTotalCount()} native dependencies`}
          onPress={() => {
            const opening = !nativeOpen();
            nativeOpen.set(opening);
            if (opening && nativeExternal) loadNative();
          }}
        />
        {nativeOpen() ? (
          nativeExternal && nativeLoading() ? (
            <Text class="text-xs text-muted-foreground">Loading native dependencies…</Text>
          ) : nativeExternal && nativeError() !== null ? (
            <View class="items-start gap-2">
              <Text class="text-xs text-muted-foreground">{nativeError()}</Text>
              <SettingsButton label="Retry native dependencies" onPress={loadNative} />
            </View>
          ) : (
            <View class="w-full gap-2">
              <Input accessibilityLabel="Search native dependencies" value={nativeQuery()} placeholder="Search native dependencies" onChange={(event) => { nativeQuery.set(event.value); nativeLimit.set(40); }} class="h-7 w-full rounded border border-input bg-transparent px-2 text-xs text-foreground" />
              <Text class="text-xs text-muted-foreground">{licenseCountLabel(matchingNative().length, nativeEntries().length)}</Text>
              {matchingNative().length ? (
                <Each of={matchingNative().slice(0, nativeLimit()) as ThirdPartyLicenseEntry[]} key={(entry) => thirdPartyLicenseEntryKey(entry)}>
                  {(entry) => {
                    const key = `native:${thirdPartyLicenseEntryKey(entry())}`;
                    return <NoticeRow entry={entry()} open={() => openKey() === key} toggle={() => openKey.set(openKey() === key ? null : key)} />;
                  }}
                </Each>
              ) : <Text class="text-xs text-muted-foreground">No native dependencies match that search.</Text>}
              {matchingNative().length > nativeLimit() ? <SettingsButton label="Show more native dependencies" onPress={() => nativeLimit.set(nativeLimit() + 40)} /> : null}
            </View>
          )
        ) : null}
      </View>
    </SettingsSection>
    <SettingsSection title="Third-party notices" headerAction={headerAction()}>
      {manifest() ? (
        filtered().length > 0 ? (
          <Each of={filtered() as ThirdPartyLicenseEntry[]} key={(entry) => thirdPartyLicenseEntryKey(entry)}>
            {(entry) => {
              const key = thirdPartyLicenseEntryKey(entry());
              return <NoticeRow entry={entry()} open={() => openKey() === key} toggle={() => openKey.set(openKey() === key ? null : key)} />;
            }}
          </Each>
        ) : <Text class="px-4 py-8 text-center text-sm text-muted-foreground">No licenses match that search.</Text>
      ) : error() !== null ? (
        <View class="items-start gap-3 px-4 py-5">
          <View class="gap-1">
            <Text class="text-sm font-medium text-foreground">Open-source notices are unavailable</Text>
            {/* NSH does not resolve `ch`; the reference's `max-w-[70ch]` (text-xs, sans) converts to
                70 * 0.5em * 12px. */}
            <Text class="max-w-[420px] text-xs leading-normal text-muted-foreground-80">{error()}</Text>
          </View>
          <View role="button" accessibilityLabel="Try again" class="h-7 items-center justify-center rounded-lg border border-input px-2.5 hover:bg-accent" onPress={load}>
            <Text class="text-xs font-medium text-foreground">Try again</Text>
          </View>
        </View>
      ) : <Text class="px-4 py-5 text-sm text-muted-foreground">Loading open-source notices…</Text>}
    </SettingsSection>
    </>
  );
}
