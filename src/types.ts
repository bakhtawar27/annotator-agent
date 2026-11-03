// Shapes shared across the agent. The codebook and schema shapes follow
// Sandpiper's (National Tutoring Observatory) so files can move between them.

export interface CodebookExample {
  _id?: string;
  example: string;
  exampleType: "NEAR_MISS" | "NEAR_HIT" | "HIT" | "MISS";
}

export interface CodebookCode {
  _id?: string;
  code: string;
  description: string;
  definition: string;
  examples: CodebookExample[];
}

export interface CodebookCategory {
  _id?: string;
  name: string;
  description: string;
  codes: CodebookCode[];
}

export interface AnnotationSchemaItem {
  fieldKey: string;
  value: unknown;
  isSystem: boolean;
  fieldType?: string;
  codes?: string[];
}
