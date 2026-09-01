/**
 * JavaScript implementation of Django-like ObjectManager and QuerySet
 * Built with pure ES2020 syntax (no external libraries or dependencies).
 * Features:
 * - Lazy Evaluation: Query chain is compiled and only executed when terminal methods (first, last, count, get, iteration) are called.
 * - Indexing / Key Lookup: Fast O(1) lookup by ID using internal Map index.
 */

/**
 * Supported filter lookup operators map.
 */
const FILTER_OPERATORS = new Set([
  'gte',
  'lte',
  'gt',
  'lt',
  'isnull',
  'in',
  'contains',
  'icontains',
  'exact',
]);

/**
 * Safely fetches nested property value from an object using a path array.
 * E.g., ['author', 'profile', 'age'] -> obj?.author?.profile?.age
 *
 * @param {Object} obj - Target object.
 * @param {string[]} pathParts - Array of keys representing the path.
 * @returns {*} Property value or undefined if path does not exist.
 */
function getNestedValue(obj, pathParts) {
  let current = obj;
  for (const part of pathParts) {
    if (current == null) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Normalizes values for comparison (converts Date instances to timestamps).
 *
 * @param {*} value
 * @returns {*}
 */
function normalizeValue(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  return value;
}

/**
 * Evaluates a single filter condition on a target item.
 * Supports double-underscore '__' syntax for nested fields and lookup operators.
 *
 * @param {Object} item - Item object to evaluate.
 * @param {string} conditionKey - Filter key, e.g., "age__gte" or "user__profile__name".
 * @param {*} targetValue - Value to compare against.
 * @returns {boolean} True if item satisfies condition.
 */
function evaluateCondition(item, conditionKey, targetValue) {
  const parts = conditionKey.split('__');
  let operator = 'exact';
  let pathParts = parts;

  const lastPart = parts[parts.length - 1];
  if (parts.length > 1 && FILTER_OPERATORS.has(lastPart)) {
    operator = lastPart;
    pathParts = parts.slice(0, -1);
  }

  const actualValue = getNestedValue(item, pathParts);

  const a = normalizeValue(actualValue);
  const t = normalizeValue(targetValue);

  switch (operator) {
    case 'gte':
      return a >= t;
    case 'lte':
      return a <= t;
    case 'gt':
      return a > t;
    case 'lt':
      return a < t;
    case 'isnull':
      return targetValue ? actualValue == null : actualValue != null;
    case 'in':
      return Array.isArray(targetValue) ? targetValue.includes(actualValue) : false;
    case 'contains':
      return typeof actualValue === 'string' && typeof targetValue === 'string'
        ? actualValue.includes(targetValue)
        : false;
    case 'icontains':
      return typeof actualValue === 'string' && typeof targetValue === 'string'
        ? actualValue.toLowerCase().includes(targetValue.toLowerCase())
        : false;
    case 'exact':
    default:
      return a === t;
  }
}

/**
 * Class representing a lazy, chainable QuerySet for filtering and sorting items.
 */
class QuerySet {
  /**
   * @param {ObjectManager} objectManager - Reference to parent ObjectManager.
   * @param {Function|Array|null} sourceItems - Function returning items array or static items array.
   * @param {Array} operations - Queued operations for lazy evaluation.
   */
  constructor(objectManager, sourceItems = null, operations = []) {
    this._objectManager = objectManager;
    this._sourceItems = sourceItems;
    this._operations = operations;
    this._evaluatedItems = null; // Cache for evaluated results
  }

  /**
   * Evaluates the pipeline lazily on demand.
   * @private
   * @returns {Array} Array of evaluated items.
   */
  _evaluate() {
    if (this._evaluatedItems !== null) {
      return this._evaluatedItems;
    }

    let items;
    if (typeof this._sourceItems === 'function') {
      items = this._sourceItems();
    } else if (Array.isArray(this._sourceItems)) {
      items = this._sourceItems;
    } else if (this._objectManager) {
      items = this._objectManager.getAllItems();
    } else {
      items = [];
    }

    let result = [...items];

    for (const op of this._operations) {
      if (op.type === 'filter') {
        const entries = Object.entries(op.conditions ?? {});
        if (entries.length > 0) {
          result = result.filter((item) =>
            entries.every(([key, val]) => evaluateCondition(item, key, val))
          );
        }
      } else if (op.type === 'orderBy') {
        const field = op.field;
        if (field && typeof field === 'string') {
          const isDescending = field.startsWith('-');
          const actualField = isDescending ? field.slice(1) : field;
          const pathParts = actualField.split('__');

          result.sort((a, b) => {
            const valA = getNestedValue(a, pathParts);
            const valB = getNestedValue(b, pathParts);

            if (valA === valB) return 0;
            if (valA == null) return 1; // Null/undefined values sorted last
            if (valB == null) return -1;

            const normA = normalizeValue(valA);
            const normB = normalizeValue(valB);

            let res = 0;
            if (normA < normB) res = -1;
            else if (normA > normB) res = 1;

            return isDescending ? -res : res;
          });
        }
      }
    }

    this._evaluatedItems = result;
    return this._evaluatedItems;
  }

  /**
   * Lazily queues filter conditions without evaluating them immediately.
   *
   * @param {Object} conditions - Filter conditions object.
   * @returns {QuerySet} A new unevaluated QuerySet instance.
   */
  filter(conditions = {}) {
    return new QuerySet(
      this._objectManager,
      this._sourceItems,
      [...this._operations, { type: 'filter', conditions }]
    );
  }

  /**
   * Lazily queues ordering field without evaluating immediately.
   *
   * @param {string} field - Field name to sort by (prefix '-' for descending).
   * @returns {QuerySet} A new unevaluated QuerySet instance.
   */
  orderBy(field) {
    return new QuerySet(
      this._objectManager,
      this._sourceItems,
      [...this._operations, { type: 'orderBy', field }]
    );
  }

  /**
   * Fast O(1) single item lookup by ID if no operations pending, else filters lazily.
   *
   * @param {*|Object} idOrConditions - ID value or condition object.
   * @returns {Object|null}
   */
  get(idOrConditions) {
    if (this._operations.length === 0 && this._objectManager) {
      if (typeof idOrConditions !== 'object' || idOrConditions === null) {
        return this._objectManager.getById(idOrConditions);
      }
      const keys = Object.keys(idOrConditions);
      const idField = this._objectManager.idField;
      if (keys.length === 1 && (keys[0] === idField || keys[0] === 'id')) {
        return this._objectManager.getById(idOrConditions[keys[0]]);
      }
    }
    return typeof idOrConditions === 'object' && idOrConditions !== null
      ? this.filter(idOrConditions).first()
      : this._objectManager?.getById(idOrConditions) ?? null;
  }

  /**
   * Terminal method: Evaluates query and returns the first item.
   * @returns {Object|null}
   */
  first() {
    const items = this._evaluate();
    return items.length > 0 ? items[0] : null;
  }

  /**
   * Terminal method: Evaluates query and returns the last item.
   * @returns {Object|null}
   */
  last() {
    const items = this._evaluate();
    return items.length > 0 ? items[items.length - 1] : null;
  }

  /**
   * Returns a cloned QuerySet.
   * @returns {QuerySet}
   */
  all() {
    return new QuerySet(this._objectManager, this._sourceItems, [...this._operations]);
  }

  /**
   * Terminal method: Evaluates query and returns item count.
   * @returns {number}
   */
  count() {
    return this._evaluate().length;
  }

  /**
   * Terminal method: Iterates lazily evaluated results in for...of loop.
   */
  [Symbol.iterator]() {
    return this._evaluate()[Symbol.iterator]();
  }
}

/**
 * Class representing an ObjectManager with O(1) ID indexing.
 */
class ObjectManager {
  /**
   * @param {Array|Map|Object} items - Initial items collection.
   * @param {Object} [options] - Configuration options.
   * @param {string} [options.idField='id'] - Field name used as ID index.
   */
  constructor(items = [], options = {}) {
    this.idField = options.idField ?? 'id';
    this._items = [];
    this._indexMap = new Map(); // ID index Map for O(1) lookups

    this._initializeItems(items);
  }

  /**
   * Extracts ID from an item object.
   * @private
   */
  _getItemId(item) {
    if (item == null) return undefined;
    return item[this.idField] ?? item.id;
  }

  /**
   * Initializes item collection and index map.
   * @private
   */
  _initializeItems(items) {
    let list = [];
    if (Array.isArray(items)) {
      list = items;
    } else if (items instanceof Map) {
      list = Array.from(items.values());
    } else if (typeof items === 'object' && items !== null) {
      list = Object.values(items);
    }

    for (const item of list) {
      this.addItem(item);
    }
  }

  /**
   * Adds an item to the manager and indexes it in the ID Map.
   * @param {Object} item
   */
  addItem(item) {
    this._items.push(item);
    const id = this._getItemId(item);
    if (id !== undefined) {
      this._indexMap.set(id, item);
    }
  }

  /**
   * Removes an item from the manager and index Map.
   * @param {Object} item
   */
  deleteItem(item) {
    const index = this._items.indexOf(item);
    if (index !== -1) {
      this._items.splice(index, 1);
    }
    const id = this._getItemId(item);
    if (id !== undefined) {
      this._indexMap.delete(id);
    }
  }

  /**
   * Direct O(1) lookup by ID.
   * @param {*} id - ID value.
   * @returns {Object|null}
   */
  getById(id) {
    return this._indexMap.get(id) ?? null;
  }

  /**
   * Returns copy of all stored items.
   * @returns {Array}
   */
  getAllItems() {
    return this._items;
  }

  /**
   * Returns a new lazy QuerySet for all items.
   * @returns {QuerySet}
   */
  all() {
    return new QuerySet(this, () => this.getAllItems());
  }

  /**
   * Delegates filter to lazy QuerySet.
   * @param {Object} conditions
   * @returns {QuerySet}
   */
  filter(conditions) {
    return this.all().filter(conditions);
  }

  /**
   * Delegates orderBy to lazy QuerySet.
   * @param {string} field
   * @returns {QuerySet}
   */
  orderBy(field) {
    return this.all().orderBy(field);
  }

  /**
   * Direct O(1) lookup by ID or filter match.
   * @param {*|Object} idOrConditions
   * @returns {Object|null}
   */
  get(idOrConditions) {
    return this.all().get(idOrConditions);
  }

  /**
   * Delegates first to QuerySet.
   * @returns {Object|null}
   */
  first() {
    return this.all().first();
  }

  /**
   * Delegates last to QuerySet.
   * @returns {Object|null}
   */
  last() {
    return this.all().last();
  }
}

export { ObjectManager, QuerySet };
