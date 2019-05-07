import {
    ApiItem,
    ApiReleaseTagMixin,
    ApiParameterListMixin,
    ApiMethod,
    ApiMethodSignature,
    ApiFunction,
    ApiConstructSignature,
    ApiConstructor,
    ApiItemKind,
    ApiClass,
    ApiEnum,
    ApiEnumMember,
    ApiInterface,
    ApiNamespace,
    ApiProperty,
    ApiPropertySignature,
    ApiVariable,
    ApiStaticMixin,
    ApiReturnTypeMixin,
    Parameter,
    ApiDeclaredItem,
    ApiDocumentedItem,
    ReleaseTag as ApiReleaseTag,
} from "@microsoft/api-extractor"
import {
    RawBaseModel,
    RawClassModel,
    Kind,
    RawInterfaceModel,
    RawMethodModel,
    RawEnumModel,
    RawNamespaceModel,
    RawPropertyModel,
    RawParameterModel,
    ReleaseTag,
    AnyRawModel,
} from "./types"
import { toId, toPermalink, toParameterId } from "./identifiers"
import { renderTSDocToHTML } from "./TSDocReactEmitter"

/**
 * Walks the api-extractor AST, calling `fn()` for each item encountered.
 * @param item  - The root level ApiItem.
 * @param level - Will include items greater than or equal to ApiReleaseTag
 * @param fn    - Called with the current item.
 */
export function walk(item: ApiItem, level: ApiReleaseTag, fn: (item: AnyRawModel) => void) {
    if (ApiReleaseTagMixin.isBaseClassOf(item) && item.releaseTag < level) {
        return
    }

    const mapped = toType(item)
    if (mapped) fn(mapped)

    for (const member of item.members) {
        walk(member, level, fn)
    }

    // ApiMethod items also have parameters...
    if (ApiParameterListMixin.isBaseClassOf(item)) {
        for (const param of item.parameters) {
            fn(toParameter(item as ApiMethod | ApiMethodSignature | ApiFunction, param))
        }
    }
}

type ApiFunctionLike = ApiMethod | ApiMethodSignature | ApiFunction | ApiConstructSignature | ApiConstructor

function toType(item: ApiItem): AnyRawModel | null {
    switch (item.kind) {
        case ApiItemKind.CallSignature:
            return null
        case ApiItemKind.Class:
            return toClass(item as ApiClass)
        case ApiItemKind.Constructor:
        case ApiItemKind.ConstructSignature:
            return toMethod(item as ApiConstructor | ApiConstructSignature)
        case ApiItemKind.EntryPoint:
            return null // No need to export this.
        case ApiItemKind.Enum:
            return toEnum(item as ApiEnum)
        case ApiItemKind.EnumMember:
            return toProperty(item as ApiEnumMember)
        case ApiItemKind.Function:
            return toMethod(item as ApiFunction)
        case ApiItemKind.IndexSignature:
            return null // TODO
        case ApiItemKind.Interface:
            return toInterface(item as ApiInterface)
        case ApiItemKind.Method:
        case ApiItemKind.MethodSignature:
            return toMethod(item as ApiMethod | ApiMethodSignature)
        case ApiItemKind.Model:
            return null // Top Level API Object
        case ApiItemKind.Namespace:
            return toNamespace(item as ApiNamespace)
        case ApiItemKind.None:
            return null // None...
        case ApiItemKind.Package:
            return null // NPM Package
        case ApiItemKind.Property:
        case ApiItemKind.PropertySignature:
            return toProperty(item as ApiProperty | ApiPropertySignature)
        case ApiItemKind.TypeAlias:
            return toCommon(item) as AnyRawModel
        case ApiItemKind.Variable:
            return toProperty(item as ApiVariable)
        default:
            return assertNever(item.kind)
    }
}

function toClass(item: ApiClass): RawClassModel {
    const constructor = item.members.find(m => m.kind === ApiItemKind.Constructor)
    const methods = item.members.filter(
        m => m.kind === ApiItemKind.Method && ApiParameterListMixin.isBaseClassOf(m) && m.overloadIndex === 0
    )
    return {
        ...toCommon(item),
        kind: Kind.Class,
        constructor: constructor ? toId(constructor) : null,
        properties: item.members.filter(m => m.kind === ApiItemKind.Property).map(toId),
        methods: methods.map(toId),
    }
}

function toInterface(item: ApiInterface): RawInterfaceModel {
    const constructor = item.members.find(m => m.kind === ApiItemKind.ConstructSignature)
    const methods = item.members.filter(
        m => m.kind === ApiItemKind.MethodSignature && ApiParameterListMixin.isBaseClassOf(m) && m.overloadIndex === 0
    )
    return {
        ...toCommon(item),
        kind: Kind.Interface,
        constructor: constructor ? toId(constructor) : null,
        properties: item.members.filter(m => m.kind === ApiItemKind.PropertySignature).map(toId),
        methods: methods.map(toId),
    }
}

function toMethod(item: ApiFunctionLike): RawMethodModel {
    let overloads: string[] = []
    if (item.parent && (item.parent.kind === ApiItemKind.Class || item.parent.kind === ApiItemKind.Interface)) {
        overloads = item.parent.members
            .filter(m => m.canonicalReference !== item.canonicalReference && m.displayName === item.displayName)
            .map(toId)
    }

    const isStatic = ApiStaticMixin.isBaseClassOf(item) ? item.isStatic : false
    const returnType = ApiReturnTypeMixin.isBaseClassOf(item) ? item.returnTypeExcerpt.text : "void"
    const returnDocs = (item.tsdocComment && item.tsdocComment.returnsBlock) || null
    const parameters = item.parameters.map(param => toParameterId(item, param))

    let name: string
    let signature: string
    if (item.parent && (item.kind === ApiItemKind.Constructor || item.kind === ApiItemKind.ConstructSignature)) {
        name = item.parent.displayName
        signature = `${item.parent.displayName}(${item.parameters.map(p => p.name).join(", ")})`
    } else if (item.parent && item.parent.kind === ApiItemKind.Namespace) {
        name = item.displayName
        signature = `${isStatic ? "static " : ""}${item.parent.displayName}.${item.displayName}(${item.parameters
            .map(p => p.name)
            .join(", ")}): ${returnType}`
    } else {
        name = item.displayName
        signature = `${isStatic ? "static " : ""}${item.displayName}(${item.parameters
            .map(p => p.name)
            .join(", ")}): ${returnType}`
    }

    return {
        ...toCommon(item),
        name,
        kind: toKind(item) as any /* yuck, fix generic on toKind */,
        returnType,
        returnMarkup: returnDocs && renderTSDocToHTML(returnDocs),
        isStatic,
        overloadIndex: item.overloadIndex,
        overloads: overloads,
        parameters,
        signature,
    }
}

function toEnum(item: ApiEnum): RawEnumModel {
    return {
        ...toCommon(item),
        kind: Kind.Enum,
        fields: item.members.filter(m => m.kind === ApiItemKind.EnumMember).map(toId),
    }
}

function toNamespace(item: ApiNamespace): RawNamespaceModel {
    return {
        ...toCommon(item),
        kind: Kind.Namespace,
        members: item.members.map(toId),
    }
}

function toProperty(item: ApiProperty | ApiPropertySignature | ApiEnumMember | ApiVariable): RawPropertyModel {
    if (item instanceof ApiEnumMember) {
        return {
            ...toCommon(item),
            kind: Kind.EnumMember,
            type: item.initializerExcerpt.text,
        }
    }
    const isStatic = ApiStaticMixin.isBaseClassOf(item) ? item.isStatic : false
    const type = item instanceof ApiVariable ? item.variableTypeExcerpt.text : item.propertyTypeExcerpt.text
    const signature = `${isStatic ? "static " : ""}${item.displayName}: ${type}`
    return {
        ...toCommon(item),
        kind: toKind(item) as any,
        type,
        signature,
    }
}

function toParameter(method: ApiMethod | ApiMethodSignature | ApiFunction, param: Parameter): RawParameterModel {
    let summaryMarkup: string | null = null
    if (param.tsdocParamBlock && param.tsdocParamBlock.content) {
        summaryMarkup = renderTSDocToHTML(param.tsdocParamBlock.content)
    } else if (method.tsdocComment && method.tsdocComment.params.blocks.length) {
        const index = method.parameters.indexOf(param)
        const doc = method.tsdocComment.params.blocks[index]
        if (doc) {
            // NOTE: This is likely the result of a malformed @param annotation missing
            // the hyphen between the parameter name and the comment.
            summaryMarkup = renderTSDocToHTML(doc.content)
        }
    }

    return {
        ...toCommon(method), // Inherit parent properties and override
        id: toParameterId(method, param),
        parentId: toId(method),
        name: param.name,
        fullname: `${method.getScopedNameWithinPackage()}.${param.name}`,
        kind: Kind.Parameter,
        type: param.parameterTypeExcerpt.text,
        summaryMarkup: summaryMarkup,
        remarksMarkup: null,
    }
}

function toCommon(item: ApiItem): RawBaseModel {
    let excerpt: string | null = null
    if (item instanceof ApiDeclaredItem && item.excerpt.text.length) {
        excerpt = item.getExcerptWithModifiers()
    }
    return {
        id: toId(item),
        parentId: item.parent ? toId(item.parent) : null,
        permalink: toPermalink(item),
        name: item.displayName,
        fullname: item.getScopedNameWithinPackage(),
        kind: toKind(item),
        releaseTag: releaseTag(item),
        visibility: visibility(item),
        signature: excerpt,
        ...extractTSDoc(item),
    }
}

function extractTSDoc(
    item: ApiItem
): {
    summaryMarkup: string | null
    remarksMarkup: string | null
    tsdoc: string | null
    deprecatedMarkup: string | null
} {
    if (item instanceof ApiDocumentedItem && item.tsdocComment) {
        const tsdoc = item.tsdocComment
        return {
            tsdoc: tsdoc.emitAsTsdoc(),
            summaryMarkup: renderTSDocToHTML(tsdoc.summarySection) || null,
            remarksMarkup: renderTSDocToHTML(tsdoc.remarksBlock) || null,
            deprecatedMarkup: renderTSDocToHTML(tsdoc.deprecatedBlock) || null,
        }
    }

    return { summaryMarkup: null, tsdoc: null, remarksMarkup: null, deprecatedMarkup: null }
}

function toKind(item: ApiItem): Kind {
    switch (item.kind) {
        case ApiItemKind.Class:
            return Kind.Class
        case ApiItemKind.Constructor:
            return Kind.Constructor
        case ApiItemKind.ConstructSignature:
            return Kind.ConstructSignature
        case ApiItemKind.Enum:
            return Kind.Enum
        case ApiItemKind.EnumMember:
            return Kind.EnumMember
        case ApiItemKind.Function:
            return Kind.Function
        case ApiItemKind.Interface:
            return Kind.Interface
        case ApiItemKind.Method:
            return Kind.Method
        case ApiItemKind.MethodSignature:
            return Kind.MethodSignature
        case ApiItemKind.Namespace:
            return Kind.Namespace
        case ApiItemKind.Property:
            return Kind.Property
        case ApiItemKind.PropertySignature:
            return Kind.PropertySignature
        case ApiItemKind.TypeAlias:
            return Kind.TypeAlias
        case ApiItemKind.Variable:
            return Kind.Variable
        case ApiItemKind.CallSignature:
        case ApiItemKind.EntryPoint:
        case ApiItemKind.IndexSignature:
        case ApiItemKind.Model:
        case ApiItemKind.None:
        case ApiItemKind.Package:
            throw new Error(`ApiItemKind: ${item.kind} is unsupported by the FramerAPI.Kind enum`)
        default:
            return assertNever(item.kind)
    }
}

function visibility(item: ApiItem) {
    if (!ApiReleaseTagMixin.isBaseClassOf(item)) return "public"
    switch (item.releaseTag) {
        case ApiReleaseTag.Public:
            return "public"
        case ApiReleaseTag.Beta:
            return "beta"
        case ApiReleaseTag.Alpha:
            return "alpha"
        case ApiReleaseTag.Internal:
            return "internal"
        case ApiReleaseTag.None:
            return "none"
        default:
            return assertNever(item.releaseTag)
    }
}

function releaseTag(item: ApiItem): ReleaseTag {
    if (!ApiReleaseTagMixin.isBaseClassOf(item)) {
        return ReleaseTag.None
    }
    const releaseTag = item.releaseTag
    switch (releaseTag) {
        case ApiReleaseTag.None:
            return ReleaseTag.None
        case ApiReleaseTag.Internal:
            return ReleaseTag.Internal
        case ApiReleaseTag.Alpha:
            return ReleaseTag.Alpha
        case ApiReleaseTag.Beta:
            return ReleaseTag.Beta
        case ApiReleaseTag.Public:
            return ReleaseTag.Public
        default:
            return assertNever(releaseTag)
    }
}

function assertNever(x: never): never {
    throw new Error("Unexpected object: " + x)
}
