import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateUrl = new URL("../infra/aws-agentcore-paperclip.yaml", import.meta.url);
const wrapperUrl = new URL("./aws-agentcore.sh", import.meta.url);

test("AgentCore template has closed development/private resources and explicit command denial", async () => {
  const source = await readFile(templateUrl, "utf8");
  for (const resource of [
    "AWS::BedrockAgentCore::Harness",
    "AWS::BedrockAgentCore::Memory",
    "AWS::EC2::VPC",
    "com.amazonaws.${AWS::Region}.ecr.api",
    "com.amazonaws.${AWS::Region}.ecr.dkr",
    "com.amazonaws.${AWS::Region}.s3",
    "com.amazonaws.${AWS::Region}.bedrock-runtime",
  ]) assert.match(source, new RegExp(resource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /AllowedValues: \[development, private\]/);
  assert.match(source, /Effect: Deny\s+Action: bedrock-agentcore:InvokeAgentRuntimeCommand/g);
  assert.doesNotMatch(source, /Effect: Allow\s+Action: bedrock-agentcore:InvokeAgentRuntimeCommand/);
  assert.doesNotMatch(source, /AWS::EC2::NatGateway|AWS::EC2::InternetGateway/);
  assert.match(source, /EventExpiryDuration: 90/);
  assert.match(source, /MaxIterations: 8/);
  assert.match(source, /MaxTokens: 4096/);
  assert.match(source, /TimeoutSeconds: 300/);
  assert.match(source, /AllowedTools:\s+- "@\*\/pc_\*"/);
  assert.match(source, /Tools: \[\]/);
  assert.match(source, /Skills: \[\]/);
  assert.doesNotMatch(source, /BedrockModelResourceArn:\s+[\s\S]{0,100}Default: "\*"/);
  assert.match(source, /BedrockFoundationModelResourceArn/);
  assert.match(source, /HarnessEndpointName/);
  assert.match(source, /\$\{AgentHarness\.Arn\}\/harness-endpoint\/\$\{HarnessEndpointName\}/);
  assert.match(source, /\$\{AgentHarness\.Arn\}\/runtime-endpoint\/\$\{HarnessEndpointName\}/);
  assert.match(source, /BedrockMarketplaceProductId/);
  assert.match(source, /Sid: ViewMarketplaceSubscriptionsForModelAccess[\s\S]*Action: aws-marketplace:ViewSubscriptions[\s\S]*Sid: SubscribePinnedMarketplaceModel[\s\S]*Action: aws-marketplace:Subscribe[\s\S]*aws-marketplace:ProductId: !Ref BedrockMarketplaceProductId/);
  assert.doesNotMatch(source, /aws-marketplace:Unsubscribe/);
});

test("AgentCore wrapper is valid shell and writes only nonsecret profile metadata", async () => {
  execFileSync("bash", ["-n", wrapperUrl.pathname]);
  const source = await readFile(wrapperUrl, "utf8");
  const generatedBlock = source.slice(source.indexOf('"AWS_PROFILE=$AWS_PROFILE_NAME"'), source.indexOf('>"$tmp"'));
  assert.ok(generatedBlock.length > 0);
  assert.doesNotMatch(generatedBlock, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|Authorization|X-Amz-Signature/);
  assert.match(source, /chmod 600 "\$tmp"/);
  assert.match(source, /printf 'AWS_CONFIG_FILE=%s\\n'/);
  assert.match(source, /cloudformation deploy/);
  assert.match(source, /CAPABILITY_NAMED_IAM/);
  assert.match(source, /--\) shift ;;/);
  assert.match(source, /iam get-role --role-name "\$role_name"/);
  assert.doesNotMatch(source, /printf 'arn:%s:iam::%s:role\/%s/);
  assert.match(source, /existing_status.*ROLLBACK_COMPLETE/s);
  assert.match(source, /cloudformation wait stack-delete-complete/);
  assert.match(source, /--query harness\.status/);
  assert.match(source, /AgentCore tool allowlist drift/);
  assert.match(source, /--query memory\.status/);
  assert.match(source, /--query endpoint\.status/);
  assert.match(source, /o\.endpoint\?\.arn/);
  assert.match(source, /--marketplace-product-id/);
  assert.match(source, /BedrockMarketplaceProductId=\$MARKETPLACE_PRODUCT_ID/);
  assert.ok(source.indexOf("delete-harness-endpoint") < source.lastIndexOf("cloudformation delete-stack"));
});
