import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { Toggle } from "../ui/toggle";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";

// Gemini Live only exists on the streaming endpoint, so anything that sends a
// finished recording (re-transcribe, upload, the fallback when Live will not
// start) is quietly switched to Gemini 3.5 Transcribe. This exposes that swap
// so it can be ruled out when chasing a bug. Shown only to Gemini users; for
// everyone else it does nothing.
export default function GeminiLiveBatchSwapSetting() {
  const { t } = useTranslation();
  const enabled = useSettingsStore((s) => s.geminiLiveBatchSwap);
  const setEnabled = useSettingsStore((s) => s.setGeminiLiveBatchSwap);
  const usesGemini = useSettingsStore(
    (s) =>
      s.cloudTranscriptionProvider === "gemini" || s.uploadCloudTranscriptionProvider === "gemini"
  );

  if (!usesGemini) return null;

  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.speechToText.geminiLiveBatchSwap.label")}
          description={t("settingsPage.speechToText.geminiLiveBatchSwap.description")}
        >
          <Toggle checked={enabled} onChange={setEnabled} />
        </SettingsRow>
      </SettingsPanelRow>
    </SettingsPanel>
  );
}
