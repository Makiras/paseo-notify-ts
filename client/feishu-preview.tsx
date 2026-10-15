import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsRow, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { noticeLabels, type NoticeKind } from "../shared/config";
import { renderFeishuCard } from "../shared/feishu";
import { notificationExample } from "../shared/notification-example";
import { messageTemplateSchema } from "../shared/template-schema";
import type { MessageFormat } from "../shared/templates";

const colors = {
  green: "#237b42",
  red: "#b42332",
  orange: "#945300",
  blue: "#245cc0",
};

export function FeishuPreview({
  format,
  theme,
}: {
  format: MessageFormat;
  theme: PluginSurfaceProps["theme"];
}) {
  const [kind, setKind] = useState<NoticeKind>("completed");
  const parsed = messageTemplateSchema.safeParse(format.template);
  const card = parsed.success
    ? renderFeishuCard(notificationExample(kind), {
        ...format,
        template: parsed.data,
      })
    : null;
  return (
    <>
      <SettingsRow
        label="卡片示例"
        hint="使用当前模板草稿和示例任务，不会发送消息。颜色随通知类型变化，实际外观以飞书为准。"
      />
      <SettingsSelect
        label="示例通知类型"
        value={kind}
        options={Object.entries(noticeLabels).map(([value, label]) => ({
          value,
          label,
        }))}
        onValueChange={(value) => setKind(value as NoticeKind)}
      />
      {card ? (
        <View
          testID="feishu-card-preview"
          style={{
            margin: 12,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              backgroundColor: colors[card.header.template],
              padding: 12,
            }}
          >
            <Text style={{ color: "#fff", fontWeight: "600" }}>
              {card.header.title.content}
            </Text>
          </View>
          <ScrollView
            style={{ maxHeight: 240 }}
            contentContainerStyle={{ padding: 12 }}
            nestedScrollEnabled
          >
            <Text selectable style={{ color: theme.colors.foreground }}>
              {card.elements[0]!.text.content}
            </Text>
          </ScrollView>
        </View>
      ) : (
        <SettingsRow
          label="暂时无法预览"
          hint="请先到“通知管理”修正消息模板中的错误。"
        />
      )}
    </>
  );
}
