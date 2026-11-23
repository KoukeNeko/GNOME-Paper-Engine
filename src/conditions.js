// SPDX-License-Identifier: GPL-3.0-or-later
//
// Evaluates the `condition` of a wallpaper option, which says when the option
// is shown, e.g. `mode.value == 2 && !simple.value`.
//
// Wallpaper Engine runs these as JavaScript. They come from Workshop content,
// so they are parsed here instead: only comparisons, && || !, parentheses,
// literals, `<option>.value` and a few string methods are understood.

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*)|(===|!==|==|!=|<=|>=|&&|\|\||[=<>!().,]))/y;
const STRING_METHODS = ['includes', 'startsWith', 'endsWith'];

function tokenize(source) {
    const tokens = [];
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < source.length) {
        const start = TOKEN.lastIndex;
        const match = TOKEN.exec(source);
        if (!match) {
            if (source.slice(start).trim() === '')
                break;
            throw new Error(`Unexpected text at “${source.slice(start)}”`);
        }
        const [, number, single, double, name, operator] = match;
        if (number !== undefined)
            tokens.push({type: 'value', value: Number(number)});
        else if (single !== undefined || double !== undefined)
            tokens.push({type: 'value', value: single ?? double});
        else if (name === 'true' || name === 'false')
            tokens.push({type: 'value', value: name === 'true'});
        else if (name !== undefined)
            tokens.push({type: 'name', value: name});
        else
            tokens.push({type: operator});
    }
    return tokens;
}

// JavaScript's == for the primitives options hold: "2" == 2, true == 1.
function looseEquals(a, b) {
    if (typeof a === typeof b)
        return a === b;
    const numeric = value => typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
    return numeric(a) === numeric(b);
}

/**
 * Whether an option with this condition is shown. `values` maps option names
 * to their current values. Conditions that cannot be understood count as met,
 * so an option is never hidden by mistake.
 */
export function evaluateCondition(condition, values) {
    let tokens;
    try {
        tokens = tokenize(condition);
    } catch (e) {
        return true;
    }
    let position = 0;
    const peek = () => tokens[position]?.type;
    const take = type => {
        if (peek() !== type)
            throw new Error(`Expected ${type}`);
        return tokens[position++];
    };

    const parsePrimary = () => {
        if (peek() === '(') {
            take('(');
            const value = parseOr();
            take(')');
            return value;
        }
        if (peek() === 'value')
            return take('value').value;

        // <option>.value, optionally followed by a string method call.
        const name = take('name').value;
        take('.');
        if (take('name').value !== 'value')
            throw new Error('Only .value is supported');
        if (!(name in values))
            throw new Error(`Unknown option ${name}`);
        let value = values[name];
        while (peek() === '.') {
            take('.');
            const method = take('name').value;
            if (!STRING_METHODS.includes(method))
                throw new Error(`Unsupported method ${method}`);
            take('(');
            const argument = parseOr();
            take(')');
            value = String(value)[method](String(argument));
        }
        return value;
    };
    const parseUnary = () => {
        if (peek() === '!') {
            take('!');
            return !parseUnary();
        }
        return parsePrimary();
    };
    const parseComparison = () => {
        const left = parseUnary();
        const operator = peek();
        switch (operator) {
        // A lone = is a typo for == in the wallpapers that use it.
        case '=': case '==': take(operator); return looseEquals(left, parseUnary());
        case '!=': take(operator); return !looseEquals(left, parseUnary());
        case '===': take(operator); return left === parseUnary();
        case '!==': take(operator); return left !== parseUnary();
        case '<': take(operator); return left < parseUnary();
        case '>': take(operator); return left > parseUnary();
        case '<=': take(operator); return left <= parseUnary();
        case '>=': take(operator); return left >= parseUnary();
        default: return left;
        }
    };
    const parseAnd = () => {
        let value = parseComparison();
        while (peek() === '&&') {
            take('&&');
            const right = parseComparison();
            value = value && right;
        }
        return value;
    };
    function parseOr() {
        let value = parseAnd();
        while (peek() === '||') {
            take('||');
            const right = parseAnd();
            value = value || right;
        }
        return value;
    }

    try {
        const result = parseOr();
        if (position !== tokens.length)
            throw new Error('Trailing tokens');
        return Boolean(result);
    } catch (e) {
        return true;
    }
}
