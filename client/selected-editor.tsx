import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

// Keep the selector and everything it controls inside the same visible boundary.
// This wrapper must not be keyed by the selection: credential drafts stay mounted.
export function SelectedEditor({
  selector,
  title,
  hint,
  theme,
  testID,
  children,
}: {
  selector: ReactNode;
  title: string;
  hint: string;
  theme: PluginSurfaceProps["theme"];
  testID: string;
  children: ReactNode;
}) {
  return (
    <View
      testID={testID}
      style={{
        borderWidth: 1,
        borderLeftWidth: 3,
        borderColor: theme.colors.border,
        borderLeftColor: theme.colors.accent,
        borderRadius: 10,
        minWidth: 0,
      }}
    >
      <View
        style={{
          backgroundColor: theme.colors.surface1,
          borderTopLeftRadius: 8,
          borderTopRightRadius: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        {selector}
        <View style={{ padding: 12, paddingTop: 4, gap: 6 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
            {title}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted }}>{hint}</Text>
        </View>
      </View>
      <View style={{ padding: 8, gap: 12 }}>{children}</View>
    </View>
  );
}
