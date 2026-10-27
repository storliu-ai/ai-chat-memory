export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportValidationError'
  }
}
