# Naming

## State in the name what you would state in its doc

A name carries the one feature that sets the thing apart, in plain words, so a reader doesn't need its doc or body to know what it does. Avoid overloaded words that leave that feature to be guessed.

- `isNonBlank` → `isNonEmptyAfterTrimming`: "blank" can mean empty, whitespace-only, or unset, and the check's distinct feature is that it trims before testing for emptiness.

## Booleans answer a yes-or-no question

A boolean's name is the question it answers, starting with a verb such as `is`, `has`, `can` or `should`, so a reader knows it's a flag and which way round it reads.

- `conversational` → `isConversational`
