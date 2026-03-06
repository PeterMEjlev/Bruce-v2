'use strict';

class FunctionRegistry {
  constructor() {
    // Map<string, { description, parameters, handler }>
    this._functions = new Map();
  }

  /**
   * Register a callable function that Bruce can invoke during conversation.
   * @param {string} name - Unique snake_case function name
   * @param {string} description - Description for the LLM to understand when to call it
   * @param {object} parameters - JSON Schema object describing the function arguments
   * @param {Function} handler - async (args) => string result
   */
  register(name, description, parameters, handler) {
    if (this._functions.has(name)) {
      throw new Error(`Function "${name}" is already registered`);
    }
    this._functions.set(name, { description, parameters, handler });
  }

  /**
   * Returns the OpenAI tool definitions array for use in session.update.
   * @returns {Array<{type: string, name: string, description: string, parameters: object}>}
   */
  getToolDefinitions() {
    return Array.from(this._functions.entries()).map(([name, fn]) => ({
      type: 'function',
      name,
      description: fn.description,
      parameters: fn.parameters,
    }));
  }

  /**
   * Execute a registered function by name with parsed arguments.
   * @param {string} name
   * @param {object} args - Already-parsed argument object
   * @returns {Promise<string>} Result string to feed back into the conversation
   */
  async execute(name, args) {
    const fn = this._functions.get(name);
    if (!fn) throw new Error(`Unknown function: "${name}"`);
    const result = await fn.handler(args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  has(name) {
    return this._functions.has(name);
  }

  get size() {
    return this._functions.size;
  }
}

module.exports = FunctionRegistry;
