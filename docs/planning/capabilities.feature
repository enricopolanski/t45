# Product context: People configure agents with reusable declarative capabilities and their own credentials. Executions read application data through the resources people use.
# Decisions:
# - Definitions live in packages/capabilities. A bundle can declare any mix of skills, files/scripts, MCP servers, dependencies, network rules, secrets and an agent-readable note. The runner applies declarations generically.
# - Step, project and workflow tools remain MCP servers calling resource RPCs. Skills can provide supporting guidance.
# - Credentials are per-agent and write-only. Saved values are encrypted, cannot be read back by members or managers, and never enter the VM.
# - workflows.getStep returns the web's StepView. A step automation starts with IDs and its prompt, reads the step and downloads files with its execution token. There is no brief.
# - v1 has no command receipts or general command deduplication. Existing chat input-ID deduplication stays.
# - Use Browserless Cloud over CDP with German residential routing for amazon.de. The Web browser capability stays provider-neutral.
# - Each implementation step is independently mergeable with pre-commit and E2Es passing. Rebuild PR #10 after steps 1 and 2; do not merge it as written.
# Tags: @next is the agreed refactor. Shared provider credentials and additional product capabilities are outside scope.

@next
Feature: Agent capabilities
  People choose capabilities and configure what each one needs.
  Executions use the capabilities saved for that agent.

  Rule: Capabilities have configuration requirements

    Scenario: Create an agent with a configured capability
      Given a member can create an agent
      When they add web browsing with its required endpoint and credential
      And save the agent
      Then reopening the agent shows its capability assignment and non-secret settings
      And shows that its credential is configured without returning the credential

    Scenario: Required configuration is missing
      Given a member is configuring web browsing for an agent
      When they save without a required setting or credential
      Then the save is refused with the missing requirement identified

  Rule: Saved credentials are write-only and belong to one agent

    Scenario: Update settings without replacing a credential
      Given an agent has a saved browser credential
      When a manager updates its non-secret settings without supplying a replacement credential
      Then the existing credential is retained
      And the response does not contain the credential

    Scenario: Replace a credential
      Given an agent has a saved browser credential
      When a manager saves a replacement credential
      Then its next execution uses the replacement
      And no agent management response reveals the saved value

    Scenario: Use the agent's credential without exposing it to the VM
      Given two agents have web browsing with different credentials
      When either agent starts an execution
      Then its browser connection uses its own credential
      And the real credential is absent from the VM configuration, files, environment and saved disk

  Rule: Each execution uses its agent's saved capabilities

    Scenario: Remove a capability
      Given an agent has web browsing
      When its manager removes web browsing and saves the agent
      Then its next execution has no browser connection or browser-use instructions

    Scenario: Expose step operations as MCP tools
      Given an agent has the step-work capability
      When it starts an execution on a step
      Then its MCP tools and schemas include reading the step and contributing to it
      And tool availability does not depend on the model reading a skill

  Rule: Step automations read the same step view people use

    Scenario: Start with identifiers and read the step
      Given an automation is configured on a step
      When it starts
      Then its first message contains only the relevant IDs and automation prompt
      And no preassembled brief is supplied
      When it calls the step-reading MCP tool
      Then it receives the StepView used by the web for the same step and effective member access

    Scenario: Download a visible step file
      Given a running step automation has received a StepView containing a file
      When it downloads that file using its execution token
      Then it receives the file contents

    Scenario: Refuse a private file outside the execution's access
      Given a running step automation has access to its own step
      When it requests an unrelated private file using its execution token
      Then the download is refused

  Rule: Step work uses authorized workflow operations

    Scenario: Contribute to a workflow step
      Given an automation runs an agent with the step-work capability on a working step
      When the agent fills a field through its step MCP tool
      Then the workflow operation applies the field change to that step
      And the tool returns the actual operation result
      And ending the execution does not complete the step

    Scenario: Return a workflow refusal
      Given an automation runs an agent with the step-work capability
      When its step MCP tool requests a field change that the workflow refuses
      Then the tool returns that refusal
      And the field remains unchanged

  Rule: Project operations retain the member's access

    Scenario: Operate on the conversation's project
      Given a member starts a project conversation with an agent configured for project operations
      When the agent reads or changes a ticket through its project MCP tools
      Then the operation is limited to the conversation's project and the member's current access
      And the tool returns the actual operation result

  Rule: Workflow drafting leaves saving to the member

    Scenario: Propose a workflow
      Given a member chats with an agent configured for workflow drafting
      When the agent submits a valid draft through its workflow MCP tool
      Then the draft appears in the conversation for the member to save
      And submitting the draft does not create or change a stored workflow

  Rule: Chat inputs are deduplicated without command receipts

    Scenario: Submit the same chat input twice
      Given a chat has accepted an input ID and its content
      When the same input ID and content are submitted again
      Then no second input is added
      And this does not establish deduplication for workflow commands

  Rule: Browser traffic leaves from a cloud browser

    Scenario: Browse amazon.de through the cloud provider
      Given an agent has web browsing configured for Browserless Cloud with a German residential proxy
      When it visits amazon.de
      Then the website connection originates from the cloud browser's proxy
      And Playwright CLI controls that browser over CDP
