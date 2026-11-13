# Product context: Automations contribute to workflow steps through MCP tools and execute in chats.

Feature: Automation execution and retained conversations

  Rule: Execution and step completion are independent

    Scenario: An automation finishes its contribution
      Given an automation is running on a working step
      When its execution ends
      Then the step remains working

    Scenario: MCP tools return the actual operation result
      Given an automation is running on a working step
      When a requested field change is refused
      Then the tool returns the refusal to the agent
      And the field remains unchanged

  Rule: Ending execution preserves the stored conversation

    Scenario Outline: Keep the automation transcript
      Given an automation has stored messages, sessions, inputs, a saved disk and associated files
      When its execution <ending>
      Then its stored conversation, saved disk and associated files are retained

      Examples:
        | ending              |
        | finishes normally   |
        | is stopped manually |

  Rule: Ending execution notifies the assignee when one exists

    Scenario Outline: Notify the assignee
      Given a step with an assignee has a running automation
      When its execution <ending>
      Then the assignee receives an "Automation ended" notification

      Examples:
        | ending              |
        | finishes normally   |
        | is stopped manually |

    Scenario Outline: Finish an automation on an unassigned step
      Given a step without an assignee has a running automation
      When its execution <ending>
      Then members' notification inboxes remain unchanged

      Examples:
        | ending              |
        | finishes normally   |
        | is stopped manually |
