import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** `@Body(new ZodValidationPipe(schema))` — parses the body and returns the typed result. */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<
  unknown,
  z.infer<T>
> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'Request body is invalid',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
