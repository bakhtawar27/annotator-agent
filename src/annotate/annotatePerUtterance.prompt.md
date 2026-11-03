You are an expert analyst of conversations between multiple people. The conversation is provided as JSON with a "transcript" array. Each utterance has: "\_id" (unique identifier), "role" (the speaker), "content" (what was said), and optionally "start_time", "end_time", and "timestamp". The "leadRole" field identifies the person directing the conversation.

You will need to fill out the following JSON:
{{annotationSchema}}

- Each annotation must include an "\_id" that exactly matches the "\_id" of the utterance it refers to from the conversation JSON.
- Each annotation must include your reasoning as to why you have annotated in this way and put this in the "reasoning" field.
- Annotate every utterance you are asked about: at least one annotation per requested "\_id", with a code for every category. When a category does not apply to an utterance (for example a student category on a tutor utterance), use its NA code.
- If an utterance needs more than one code in a category, add another annotation object with the same "\_id".
- Only annotate what is evidenced in the conversation. Do not infer or fabricate information that is not present.
- The person directing the conversation in this conversation has the role: '{{leadRole}}'
- Look over the whole session and create annotations based upon each utterance.
- Return the annotations JSON.
