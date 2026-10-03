import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";

export function CompletionPanel({
  title,
  message,
  icon,
  color,
}: {
  title: string;
  message: string;
  icon: "success" | "warning" | "error";
  color: "success" | "warning" | "error";
}) {
  return (
    <div className="login-shell">
      <main className="login-panel setup-panel login-auth-panel">
        <VStack gap={5} hAlign="stretch">
          <img
            src="/assets/images/weldall.png"
            alt="Weldall"
            width={182}
            height={51}
            className="login-auth-logo"
          />
          <VStack gap={3} hAlign="stretch">
            <div className="flex items-center justify-center gap-2">
              <Heading level={1}>{title}</Heading>
              <Icon aria-hidden="true" color={color} icon={icon} size="lg" />
            </div>
            <Text as="p" color="secondary">
              {message}
            </Text>
          </VStack>
        </VStack>
      </main>
    </div>
  );
}
