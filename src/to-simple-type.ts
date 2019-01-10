import { Type, TypeChecker, Symbol, Node, Declaration } from "typescript";
import {
	SimpleTypeKind,
	SimpleType,
	isSimpleTypeLiteral,
	PRIMITIVE_TYPE_KINDS,
	SimpleTypeBooleanLiteral,
	SimpleTypeUndefined,
	SimpleTypeNull,
	SimpleTypeEnumMember,
	SimpleTypeLiteral,
	SimpleTypeFunctionArgument,
	SimpleTypeClassMember,
	SimpleTypeMethod,
	SimpleTypeFunction
} from "./simple-type";
import {
	isNumber,
	isBigInt,
	isString,
	isBoolean,
	isUndefined,
	isNull,
	isUnknown,
	isArray,
	getTypeArguments,
	isObject,
	isFunction,
	isTuple,
	isBooleanLiteral,
	isEnum,
	isLiteral,
	isBigIntLiteral,
	isVoid,
	getModifiersFromDeclaration,
	isMethod,
	isNode
} from "./ts-util";
import { tsModule } from "./ts-module";

/**
 * Converts a Typescript type to a "SimpleType"
 * @param type The type to convert.
 * @param options Converts using these options.
 */
export function toSimpleType(type: Node, checker: TypeChecker, cache?: WeakMap<Type, SimpleType>): SimpleType;
export function toSimpleType(type: Type, checker: TypeChecker, cache?: WeakMap<Type, SimpleType>): SimpleType;
export function toSimpleType(type: Type | Node, checker: TypeChecker, cache?: WeakMap<Type, SimpleType>): SimpleType {
	if (isNode(type)) {
		// "type" is a "Node", convert it to a "Type" and continue.
		return toSimpleType(checker.getTypeAtLocation(type), checker);
	}

	return toSimpleTypeInternalCaching(type, {
		checker,
		cache: cache || new WeakMap<Type, SimpleType>()
	})
}

export interface ToSimpleTypeOptions {
	cache: WeakMap<Type, SimpleType>;
	checker: TypeChecker;
}

function toSimpleTypeInternalCaching(type: Type, options: ToSimpleTypeOptions): SimpleType {

	// Mutate the simple type cache so that the type tree from now on is seperate
	// However, keep the same "idMap"
	const placeholder: SimpleType = {} as any;

	if (options.cache.has(type)) {
		// Only return a circular ref if it's a class of interface.
		// Don't return circular ref if it's a primitive like a "number"
		if (type.isClassOrInterface()) {
			return {
				kind: SimpleTypeKind.CIRCULAR_TYPE_REF,
				ref: options.cache.get(type)!
			}
		}

	} else {
		// Connect the type to the placeholder reference
		// Circular types will point to this reference
		options.cache.set(type, placeholder);
	}

	// Construct the simple type recursively
	const simpleType = toSimpleTypeInternal(type, options);

	// Transfer properties on the simpleType to the placeholder
	// This makes it possible to keep on using the reference "placeholder".
	Object.assign(placeholder, simpleType);

	return placeholder;
}


function toSimpleTypeInternal(type: Type, options: ToSimpleTypeOptions): SimpleType {
	const { checker } = options;

	const symbol = type.getSymbol();
	const aliasSymbol = type.aliasSymbol;
	const name = aliasSymbol != null ? aliasSymbol.getName() : symbol != null ? symbol.getName() : undefined;

	if (isLiteral(type)) {
		const literalSimpleType = literalToSimpleType(type, checker);
		if (literalSimpleType != null) {
			// Enum members
			if (symbol != null && symbol.flags & tsModule.ts.SymbolFlags.EnumMember) {
				const parentSymbol = (symbol as any).parent as Symbol | undefined;

				if (parentSymbol != null) {
					return {
						name: name || "",
						fullName: `${parentSymbol.name}.${name}`,
						kind: SimpleTypeKind.ENUM_MEMBER,
						type: literalSimpleType
					};
				}
			}

			// Literals types
			return literalSimpleType;
		}
	}

	// Primitive types
	else if (isString(type)) {
		return { kind: SimpleTypeKind.STRING, name };
	} else if (isNumber(type)) {
		return { kind: SimpleTypeKind.NUMBER, name };
	} else if (isBoolean(type)) {
		return { kind: SimpleTypeKind.BOOLEAN, name };
	} else if (isBigInt(type)) {
		return { kind: SimpleTypeKind.BIG_INT, name };
	} else if (isUndefined(type)) {
		return { kind: SimpleTypeKind.UNDEFINED, name };
	} else if (isNull(type)) {
		return { kind: SimpleTypeKind.NULL, name };
	} else if (isUnknown(type)) {
		return { kind: SimpleTypeKind.UNKNOWN, name };
	} else if (isVoid(type)) {
		return { kind: SimpleTypeKind.VOID, name };
	}

	// Enum
	else if (isEnum(type) && type.isUnion()) {
		return {
			name: name || "",
			kind: SimpleTypeKind.ENUM,
			types: type.types.map(t => toSimpleTypeInternalCaching(t, options) as SimpleTypeEnumMember)
		};
	}

	// Unions and intersections
	else if (type.isUnion()) {
		return {
			kind: SimpleTypeKind.UNION,
			types: simplifySimpleTypeArray(type.types.map(t => toSimpleTypeInternalCaching(t, options))),
			name
		};
	} else if (type.isIntersection()) {
		return {
			kind: SimpleTypeKind.INTERSECTION,
			types: simplifySimpleTypeArray(type.types.map(t => toSimpleTypeInternalCaching(t, options))),
			name
		};
	}

	// Array
	else if (isArray(type)) {
		const types = getTypeArguments(type);
		if (types.length === 1) {
			return {
				kind: SimpleTypeKind.ARRAY,
				type: toSimpleTypeInternalCaching(types[0], options),
				name
			};
		}
	} else if (isTuple(type)) {
		const types = getTypeArguments(type);

		return {
			kind: SimpleTypeKind.TUPLE,
			members: types.map(childType => {
				const childSymbol = childType.getSymbol();
				return {
					optional: childSymbol != null ? (childSymbol.flags & tsModule.ts.SymbolFlags.Optional) !== 0 : false,
					type: toSimpleTypeInternalCaching(childType, options)
				};
			}),
			name
		};
	}

	// Function
	else if (symbol != null && (isFunction(type) || isMethod(type))) {
		const functionDeclaration = symbol.declarations.length > 0 ? symbol.declarations[0] : symbol.valueDeclaration;
		const simpleType = getSimpleFunctionFromDeclaration(functionDeclaration, options, true);

		if (simpleType != null) {
			return simpleType;
		}
	}

	// Class
	else if (type.isClass() && symbol != null) {
		const classDecl = symbol.declarations.length > 0 ? symbol.declarations[0] : symbol.valueDeclaration;

		if (tsModule.ts.isClassDeclaration(classDecl)) {
			const ctor = (() => {
				const ctorSymbol = symbol != null && symbol.members != null ? symbol.members.get("__constructor" as any) : undefined;
				if (ctorSymbol != null && symbol != null) {
					const ctorDecl = ctorSymbol.declarations.length > 0 ? ctorSymbol.declarations[0] : ctorSymbol.valueDeclaration;

					if (ctorDecl != null && tsModule.ts.isConstructorDeclaration(ctorDecl)) {
						return getSimpleFunctionFromDeclaration(ctorDecl, options, false) as SimpleTypeFunction;
					}
				}
			})();

			const members = checker.getPropertiesOfType(type).map(
				symbol =>
					({
						name: symbol.name,
						modifiers: getModifiersFromDeclaration(symbol.valueDeclaration),
						type: toSimpleTypeInternalCaching(checker.getTypeAtLocation(symbol.valueDeclaration), options)
					} as SimpleTypeClassMember)
			);

			return {
				kind: SimpleTypeKind.CLASS,
				name,
				ctor,
				properties: members.filter(m => m.type.kind !== SimpleTypeKind.METHOD),
				methods: members.filter(m => m.type.kind === SimpleTypeKind.METHOD)
			};
		}
	}

	// Interface
	else if (type.isClassOrInterface() || isObject(type)) {
		const members = checker.getPropertiesOfType(type).map(symbol => ({
			name: symbol.name,
			optional: (symbol.flags & tsModule.ts.SymbolFlags.Optional) !== 0,
			type: toSimpleTypeInternalCaching(checker.getTypeAtLocation(symbol.valueDeclaration), options)
		}));

		if (type.isClassOrInterface()) {
			return {
				kind: SimpleTypeKind.INTERFACE,
				members,
				name
			};
		} else {
			return {
				kind: SimpleTypeKind.OBJECT,
				members,
				name
			};
		}
	}

	return {
		kind: SimpleTypeKind.ANY,
		name
	};
}

function simplifySimpleTypeArray(types: SimpleType[]): SimpleType[] {
	let newTypes: SimpleType[] = [...types];
	const NULLABLE_TYPE_KINDS = [SimpleTypeKind.UNDEFINED, SimpleTypeKind.NULL];

	// Only include one instance of primitives
	newTypes = newTypes.filter((type, i) => {
		if (isSimpleTypeLiteral(type)) return true;
		if (PRIMITIVE_TYPE_KINDS.includes(type.kind) || NULLABLE_TYPE_KINDS.includes(type.kind)) {
			// Remove this type from the array if there is already a primitive in the array
			return !newTypes
				.slice(0, i)
				.map(t => t.kind)
				.includes(type.kind);
		}

		return true;
	});

	// Simplify boolean literals
	const booleanLiteralTypes = newTypes.filter((t): t is SimpleTypeBooleanLiteral => t.kind === SimpleTypeKind.BOOLEAN_LITERAL);
	if (booleanLiteralTypes.find(t => t.value === true) != null && booleanLiteralTypes.find(t => t.value === false) != null) {
		newTypes = [...newTypes.filter(type => type.kind !== SimpleTypeKind.BOOLEAN_LITERAL), { kind: SimpleTypeKind.BOOLEAN }];
	}

	// Reorder "NULL" and "UNDEFINED" to be last
	const nullableTypes = newTypes.filter((t): t is SimpleTypeUndefined | SimpleTypeNull => NULLABLE_TYPE_KINDS.includes(t.kind));
	if (nullableTypes.length > 0) {
		newTypes = [
			...newTypes.filter(t => !NULLABLE_TYPE_KINDS.includes(t.kind)),
			...nullableTypes.sort((t1, t2) => (t1.kind === SimpleTypeKind.NULL ? (t2.kind === SimpleTypeKind.UNDEFINED ? -1 : 0) : t2.kind === SimpleTypeKind.NULL ? 1 : 0))
		];
	}

	return newTypes;
}

function literalToSimpleType(type: Type, checker: TypeChecker): SimpleTypeLiteral | undefined {
	if (type.isNumberLiteral()) {
		return {
			kind: SimpleTypeKind.NUMBER_LITERAL,
			value: type.value
		};
	} else if (type.isStringLiteral()) {
		return {
			kind: SimpleTypeKind.STRING_LITERAL,
			value: type.value
		};
	} else if (isBooleanLiteral(type)) {
		// See https://github.com/Microsoft/TypeScript/issues/22269 for more information
		return {
			kind: SimpleTypeKind.BOOLEAN_LITERAL,
			value: checker.typeToString(type) === "true"
		};
	} else if (isBigIntLiteral(type)) {
		return {
			kind: SimpleTypeKind.BIG_INT_LITERAL,
			value: BigInt(`${type.value.negative ? "-" : ""}${type.value.base10Value}`)
		};
	}
}

function getSimpleFunctionFromDeclaration(functionDeclaration: Declaration, options: ToSimpleTypeOptions, checkReturnType: boolean): SimpleTypeFunction | SimpleTypeMethod | undefined {
	const { checker } = options;

	const symbol = checker.getSymbolAtLocation(functionDeclaration);

	const type = checker.getTypeAtLocation(functionDeclaration);

	if (tsModule.ts.isFunctionLike(functionDeclaration)) {
		const signature = checker.getSignatureFromDeclaration(functionDeclaration);

		if (signature != null) {
			// Temporary solution untill circular types are supported
			const returnType = checkReturnType ? toSimpleTypeInternalCaching(checker.getReturnTypeOfSignature(signature), options) : undefined;

			const argTypes = functionDeclaration.parameters.map(parameterDecl => {
				const argType = checker.getTypeAtLocation(parameterDecl);

				return {
					name: parameterDecl.name.getText(),
					optional: parameterDecl.questionToken != null,
					type: toSimpleTypeInternalCaching(argType, options),
					spread: parameterDecl.dotDotDotToken != null,
					initializer: parameterDecl.initializer != null
				} as SimpleTypeFunctionArgument;
			});

			return {
				name: symbol != null ? symbol.getName() : undefined,
				kind: isMethod(type) ? SimpleTypeKind.METHOD : SimpleTypeKind.FUNCTION,
				returnType: returnType || { kind: SimpleTypeKind.VOID },
				argTypes
			} as SimpleTypeFunction | SimpleTypeMethod;
		}
	}
}
