import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSelect } from "@getpaseo/plugin/client/ui";

export const settingsSections = [
  { value: "channels", label: "通知渠道" },
  { value: "schedules", label: "定时任务" },
  { value: "recovery", label: "自动恢复" },
  { value: "notifications", label: "通知选项" },
  { value: "transfer", label: "导入导出" },
  { value: "activity", label: "运行状态" },
  { value: "updates", label: "版本更新" },
] as const;
export type SettingsSectionId = (typeof settingsSections)[number]["value"];

// One instance per client contribution (and therefore per Host installation).
// Commands can select a section before opening the screen, or while it is open.
export function createSettingsNavigation() {
  let section: SettingsSectionId = "channels";
  const listeners = new Set<() => void>();
  return {
    current: () => section,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select(next: SettingsSectionId) {
      section = next;
      for (const listener of listeners) listener();
    },
  };
}
export type SettingsNavigation = ReturnType<typeof createSettingsNavigation>;

export function SectionNavigation({
  value,
  onChange,
  theme,
  compact,
}: {
  value: SettingsSectionId;
  onChange(value: SettingsSectionId): void;
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
}) {
  if (compact)
    return (
      <SettingsCard>
        <SettingsSelect
          label="设置栏目"
          value={value}
          options={[...settingsSections]}
          onValueChange={(next) => {
            const section = settingsSections.find((s) => s.value === next);
            if (section) onChange(section.value);
          }}
        />
      </SettingsCard>
    );
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {settingsSections.map((section) => {
        const selected = section.value === value;
        return (
          <Pressable
            key={section.value}
            accessibilityRole="tab"
            accessibilityLabel={section.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(section.value)}
            style={{
              minHeight: 40,
              paddingVertical: 10,
              paddingHorizontal: 14,
              borderRadius: 8,
              backgroundColor: selected
                ? theme.colors.accent
                : theme.colors.surface1,
            }}
          >
            <Text
              style={{
                color: selected
                  ? theme.colors.accentForeground
                  : theme.colors.foreground,
                fontWeight: selected ? "600" : "400",
              }}
            >
              {section.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SettingsPanel({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  // Keep mount-only native inputs and private credential handles alive. Hidden
  // panels occupy no space and are excluded from focus/accessibility traversal.
  return (
    <View
      style={{ display: active ? "flex" : "none", gap: 16 }}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
    >
      {children}
    </View>
  );
}
