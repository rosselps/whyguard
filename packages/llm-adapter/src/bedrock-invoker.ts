import type * as BedrockRuntime from "@aws-sdk/client-bedrock-runtime";
import type { BedrockRuntimeClientConfig } from "@aws-sdk/client-bedrock-runtime";

/**
 * Shape of the dynamically imported AWS SDK module. Typed via a namespace import so the
 * SDK stays a *type-only* dependency at build time: nothing here forces it to be
 * installed for the deterministic path to work.
 */
type BedrockSdk = typeof BedrockRuntime;

/**
 * Port interface for the "call a model" step's rule "No model calls outside `llm-adapter`" trust boundary ("LLM output is untrusted and must pass schema validation").
 * `explain-finding.ts` depends only on this interface, never on the AWS SDK
 * directly, so tests can inject a fake invoker without any AWS credentials.
 */
export type BedrockInvoker = {
  /** Sends a prompt to the configured model and returns its raw text response. */
  invoke(prompt: string): Promise<string>;
};

export type BedrockInvokerConfig = {
  region: string;
  modelId: string;
  /** Injectable for tests; defaults to a real `BedrockRuntimeClient`. */
  clientConfig?: BedrockRuntimeClientConfig;
};

/**
 * Creates a real Bedrock-backed invoker. Uses the Anthropic Messages API request
 * shape, which is what Bedrock's Claude models expect — if `modelId` points at a
 * non-Claude model, `explain-finding.ts`'s JSON-parsing step will fail cleanly and
 * fall back's fallback rule, rather than throwing an unhandled error.
 *
 * The AWS SDK is loaded with a dynamic `import()` on first invocation, not at module
 * load time, and is declared an `optionalDependency` of the published CLI. Bedrock is
 * opt-in at runtime (it requires `WHYGUARD_LLM_ENABLED=true` plus `AWS_REGION` and
 * `BEDROCK_MODEL_ID`), so a static import would force every user who installs the CLI
 * to download the AWS SDK for a code path their default configuration never reaches.
 * rule that "the demo must still work" without Bedrock applies to
 * installation too, not just execution.
 *
 * A missing SDK therefore surfaces here, as an actionable error naming the package to
 * install, rather than as an opaque module-resolution failure at startup.
 */
export function createBedrockInvoker(config: BedrockInvokerConfig): BedrockInvoker {
  // Resolved once and reused, so repeated invocations don't re-import or rebuild the
  // client (which would also re-resolve credentials on every finding).
  let clientPromise: Promise<{
    client: { send: (command: unknown) => Promise<{ body: Uint8Array }> };
    InvokeModelCommand: new (input: unknown) => unknown;
  }> | null = null;

  async function getClient() {
    clientPromise ??= (async () => {
      let sdk: BedrockSdk;
      try {
        sdk = await import("@aws-sdk/client-bedrock-runtime");
      } catch (error) {
        throw new Error(
          "Bedrock explanations are enabled but @aws-sdk/client-bedrock-runtime is not " +
            "installed. Install it, or unset WHYGUARD_LLM_ENABLED to use the " +
            "deterministic fallback.",
          { cause: error },
        );
      }
      return {
        client: new sdk.BedrockRuntimeClient(
          config.clientConfig ?? { region: config.region },
        ) as unknown as { send: (command: unknown) => Promise<{ body: Uint8Array }> },
        InvokeModelCommand: sdk.InvokeModelCommand as unknown as new (input: unknown) => unknown,
      };
    })();
    return clientPromise;
  }

  return {
    async invoke(prompt: string): Promise<string> {
      const { client, InvokeModelCommand } = await getClient();
      const command = new InvokeModelCommand({
        modelId: config.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const response = await client.send(command);
      const bodyText = new TextDecoder().decode(response.body);
      const parsed = JSON.parse(bodyText) as { content?: { text?: string }[] };
      const text = parsed.content?.[0]?.text;
      if (!text) {
        throw new Error("Bedrock response did not include any text content.");
      }
      return text;
    },
  };
}
