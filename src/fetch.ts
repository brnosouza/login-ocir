const originalFetch = globalThis.fetch

globalThis.fetch = async (...args: Parameters<typeof originalFetch>): Promise<Response> => {
  try {
    return await originalFetch(...args)
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    const causes: unknown[] = [error, cause, ...(cause instanceof AggregateError ? cause.errors : [])]
    const codes = [
      ...new Set(
        causes.flatMap(item =>
          item &&
          typeof item === 'object' &&
          'code' in item &&
          typeof item.code === 'string' &&
          /^[A-Z0-9_]+$/.test(item.code)
            ? [item.code]
            : []
        )
      )
    ]
    globalThis.console.error(`OCI fetch transport failure: ${codes.join(', ') || 'no error code available'}`)
    throw error
  }
}
