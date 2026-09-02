type SchemaOptions = Record<string, unknown>;
type Schema = SchemaOptions & { type?: string; properties?: Record<string, Schema>; required?: string[] };
type OptionalSchema = Schema & { __optional?: true };

function stripOptionalMarker(schema: OptionalSchema): Schema {
  const { __optional, ...rest } = schema;
  return rest;
}

export const Type = {
  Object(properties: Record<string, OptionalSchema>, options: SchemaOptions = {}): Schema {
    const required = Object.entries(properties)
        .filter(([, schema]) => !schema.__optional)
        .map(([name]) => name),
      normalized = Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [name, stripOptionalMarker(schema)]),
      );
    return {
      type: 'object',
      properties: normalized,
      ...(required.length > 0 ? { required } : {}),
      ...options,
    };
  },
  String(options: SchemaOptions = {}): Schema {
    return { type: 'string', ...options };
  },
  Number(options: SchemaOptions = {}): Schema {
    return { type: 'number', ...options };
  },
  Boolean(options: SchemaOptions = {}): Schema {
    return { type: 'boolean', ...options };
  },
  Optional(schema: Schema): OptionalSchema {
    return { ...schema, __optional: true };
  },
};
