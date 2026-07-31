const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const checkedIn = path.join(root, 'docs', 'protocol', 'v1');
const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const skipCompile = args.has('--skip-compile');
const kotlinVersion = '2.4.10';
const kotlinArchiveSha256 =
  '473dd66c7a3ef4b182065b3da670466c1bf2773a9dbb0ed8b33a39fe9d4f876d';
const temurinVersion = '21.0.11_10';
const temurinMacArm64Sha256 =
  '4b7a8cd23102c251c8b8be42a9a5f1263fb337cf1037f6f64b25f3070efe4b76';

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed (${result.status})\n${
        result.stdout || ''
      }\n${result.stderr || ''}`,
    );
  }
  return result;
}

function requireDefinitions(schema) {
  const names = [
    'CreatePairingRequest',
    'DeviceCredential',
    'OfflineConversationCache',
    'PairingChallenge',
    'RedeemPairingRequest',
    'RemoteEvent',
    'TerminalNotificationSummary',
  ];
  for (const name of names) {
    if (!schema.$defs?.[name]) {
      throw new Error(`schema is missing required definition ${name}`);
    }
  }
}

function generatedHeader(comment) {
  return `${comment} Generated from docs/protocol/v1/schema.json. Do not edit.\n`;
}

function referenceName(reference) {
  return reference.split('/').at(-1);
}

function schemaType(schema, language, definitions) {
  if (schema === true || !schema) {
    return language === 'typescript'
      ? 'JsonValue'
      : language === 'swift'
        ? 'JSONValue'
        : 'JsonValue';
  }
  if (schema.$ref) {
    const name = referenceName(schema.$ref);
    return definitions[name]?.oneOf && language !== 'typescript'
      ? language === 'swift'
        ? 'JSONValue'
        : 'JsonValue'
      : name;
  }
  if (schema.const !== undefined) {
    if (language === 'typescript') return JSON.stringify(schema.const);
    if (typeof schema.const === 'string') return 'String';
    return language === 'swift' ? 'Bool' : 'Boolean';
  }
  if (schema.oneOf || schema.anyOf) {
    const variants = schema.oneOf || schema.anyOf;
    if (language === 'typescript') {
      return variants
        .map((variant) => schemaType(variant, language, definitions))
        .join(' | ');
    }
    return language === 'swift' ? 'JSONValue' : 'JsonValue';
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = types.includes('null');
  const type = types.find((candidate) => candidate !== 'null');
  let rendered;
  if (type === 'string') rendered = language === 'typescript' ? 'string' : 'String';
  else if (type === 'integer')
    rendered = language === 'typescript' ? 'number' : language === 'swift' ? 'Int64' : 'Long';
  else if (type === 'number')
    rendered = language === 'typescript' ? 'number' : 'Double';
  else if (type === 'boolean')
    rendered = language === 'typescript' ? 'boolean' : language === 'swift' ? 'Bool' : 'Boolean';
  else if (type === 'array') {
    const item = schemaType(schema.items, language, definitions);
    rendered =
      language === 'typescript' ? `${item}[]` : language === 'swift' ? `[${item}]` : `List<${item}>`;
  } else if (type === 'object') {
    if (language === 'typescript' && schema.properties) {
      const required = new Set(schema.required || []);
      rendered = `{ ${Object.entries(schema.properties)
        .map(
          ([field, fieldSchema]) =>
            `${field}${required.has(field) ? '' : '?'}: ${schemaType(
              fieldSchema,
              language,
              definitions,
            )}`,
        )
        .join('; ')} }`;
    } else {
      rendered =
        language === 'typescript'
          ? '{ [key: string]: JsonValue }'
          : language === 'swift'
            ? 'JSONValue'
            : 'JsonValue';
    }
  } else {
    rendered = language === 'typescript' ? 'JsonValue' : language === 'swift' ? 'JSONValue' : 'JsonValue';
  }
  if (nullable) {
    return language === 'typescript' ? `${rendered} | null` : `${rendered}?`;
  }
  return rendered;
}

function typescriptDefinition(name, definition, definitions) {
  if (definition.enum) {
    return `export type ${name} = ${definition.enum
      .map((value) => JSON.stringify(value))
      .join(' | ')};\n`;
  }
  if (definition.oneOf || definition.anyOf) {
    const union = schemaType(definition, 'typescript', definitions);
    const base =
      definition.properties && Object.keys(definition.properties).length > 0
        ? `${schemaType(
            {
              type: 'object',
              properties: definition.properties,
              required: definition.required,
            },
            'typescript',
            definitions,
          )} & `
        : '';
    return `export type ${name} = ${base}(${union});\n`;
  }
  if (definition.type !== 'object' || !definition.properties) {
    return `export type ${name} = ${schemaType(
      definition,
      'typescript',
      definitions,
    )};\n`;
  }
  const required = new Set(definition.required || []);
  const fields = Object.entries(definition.properties || {})
    .map(
      ([field, fieldSchema]) =>
        `  ${field}${required.has(field) ? '' : '?'}: ${schemaType(
          fieldSchema,
          'typescript',
          definitions,
        )};`,
    )
    .join('\n');
  return `export interface ${name} {\n${fields}\n}\n`;
}

function typescriptModels(schema) {
  const definitions = schema.$defs;
  const models = Object.keys(definitions)
    .map((name) => typescriptDefinition(name, definitions[name], definitions))
    .join('\n');
  return `${generatedHeader('//')}
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

${models}`;
}

function swiftDefinition(name, definition, definitions) {
  if (definition.enum) {
    const reserved = new Set([
      'associatedtype',
      'class',
      'deinit',
      'enum',
      'extension',
      'fileprivate',
      'func',
      'import',
      'init',
      'inout',
      'internal',
      'let',
      'open',
      'operator',
      'private',
      'protocol',
      'public',
      'rethrows',
      'static',
      'struct',
      'subscript',
      'typealias',
      'var',
    ]);
    const cases = definition.enum
      .map((value) => `    case ${reserved.has(value) ? `\`${value}\`` : value}`)
      .join('\n');
    return `public enum ${name}: String, Codable {\n${cases}\n}\n`;
  }
  if (definition.oneOf || definition.anyOf) {
    return `public typealias ${name} = JSONValue\n`;
  }
  if (definition.type !== 'object' || !definition.properties) {
    return `public typealias ${name} = ${schemaType(
      definition,
      'swift',
      definitions,
    )}\n`;
  }
  const required = new Set(definition.required || []);
  const fields = Object.entries(definition.properties || {})
    .map(([field, fieldSchema]) => {
      let type = schemaType(fieldSchema, 'swift', definitions);
      if (!required.has(field) && !type.endsWith('?')) type += '?';
      return `    public let ${field}: ${type}`;
    })
    .join('\n');
  return `public struct ${name}: Codable {\n${fields}\n}\n`;
}

function swiftModels(schema) {
  const definitions = schema.$defs;
  const models = Object.keys(definitions)
    .map((name) => swiftDefinition(name, definitions[name], definitions))
    .join('\n');
  return `${generatedHeader('//')}
import Foundation

public enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .bool(item) }
        else if let item = try? value.decode(Double.self) { self = .number(item) }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode([JSONValue].self) { self = .array(item) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .string(let item): try value.encode(item)
        case .array(let item): try value.encode(item)
        case .object(let item): try value.encode(item)
        }
    }
}

${models}`;
}

function kotlinDefinition(name, definition, definitions) {
  if (definition.enum) {
    return `enum class ${name} { ${definition.enum
      .map((value) => value.toUpperCase())
      .join(', ')} }\n`;
  }
  if (definition.oneOf || definition.anyOf) {
    return `typealias ${name} = JsonValue\n`;
  }
  if (definition.type !== 'object' || !definition.properties) {
    return `typealias ${name} = ${schemaType(
      definition,
      'kotlin',
      definitions,
    )}\n`;
  }
  const required = new Set(definition.required || []);
  const fields = Object.entries(definition.properties || {}).map(
    ([field, fieldSchema]) => {
      let type = schemaType(fieldSchema, 'kotlin', definitions);
      let defaultValue = '';
      if (!required.has(field)) {
        if (fieldSchema.const === true) defaultValue = ' = true';
        else if (fieldSchema.type === 'array') defaultValue = ' = emptyList()';
        else {
          if (!type.endsWith('?')) type += '?';
          defaultValue = ' = null';
        }
      }
      return `    val ${field}: ${type}${defaultValue},`;
    },
  );
  const remoteCodec =
    name === 'RemoteEvent'
      ? `
) {
    companion object {
        fun decodeJson(input: String): RemoteEvent {
            val root = JsonValue.parse(input) as JsonValue.Object
            return RemoteEvent(
                sequence = (root.value["sequence"] as JsonValue.Number).value.toLong(),
                kind = (root.value["kind"] as JsonValue.Text).value,
                payload = root.value.getValue("payload"),
            )
        }
    }

    fun encodeJson(): String = JsonValue.Object(
        mapOf(
            "sequence" to JsonValue.Number(sequence.toDouble()),
            "kind" to JsonValue.Text(kind),
            "payload" to payload,
        ),
    ).encode()
}
`
      : `\n)\n`;
  return `data class ${name}(\n${fields.join('\n')}${remoteCodec}`;
}

function kotlinModels(schema) {
  const definitions = schema.$defs;
  const models = Object.keys(definitions)
    .map((name) => kotlinDefinition(name, definitions[name], definitions))
    .join('\n');
  return `${generatedHeader('//')}
package dev.vibex.remote.v1

sealed interface JsonValue {
    data object Null : JsonValue
    data class Bool(val value: Boolean) : JsonValue
    data class Number(val value: Double) : JsonValue
    data class Text(val value: String) : JsonValue
    data class Array(val value: List<JsonValue>) : JsonValue
    data class Object(val value: Map<String, JsonValue>) : JsonValue

    fun encode(): String = when (this) {
        Null -> "null"
        is Bool -> value.toString()
        is Number -> if (value % 1.0 == 0.0) value.toLong().toString() else value.toString()
        is Text -> "\\"\${escape(value)}\\""
        is Array -> value.joinToString(prefix = "[", postfix = "]") { it.encode() }
        is Object -> value.entries.joinToString(prefix = "{", postfix = "}") {
            "\\"\${escape(it.key)}\\":\${it.value.encode()}"
        }
    }

    companion object {
        fun parse(input: String): JsonValue = Parser(input).parse()

        private fun escape(value: String): String = buildString {
            value.forEach { character ->
                append(
                    when (character) {
                        '\\\\' -> "\\\\\\\\"
                        '"' -> "\\\\\\""
                        '\\n' -> "\\\\n"
                        '\\r' -> "\\\\r"
                        '\\t' -> "\\\\t"
                        else -> character
                    },
                )
            }
        }
    }
}

private class Parser(private val input: String) {
    private var index = 0

    fun parse(): JsonValue {
        val value = value()
        whitespace()
        require(index == input.length) { "trailing JSON" }
        return value
    }

    private fun value(): JsonValue {
        whitespace()
        return when (input.getOrNull(index)) {
            '{' -> objectValue()
            '[' -> arrayValue()
            '"' -> JsonValue.Text(stringValue())
            't' -> literal("true", JsonValue.Bool(true))
            'f' -> literal("false", JsonValue.Bool(false))
            'n' -> literal("null", JsonValue.Null)
            else -> numberValue()
        }
    }

    private fun objectValue(): JsonValue {
        index++
        val values = linkedMapOf<String, JsonValue>()
        whitespace()
        if (input.getOrNull(index) == '}') {
            index++
            return JsonValue.Object(values)
        }
        while (true) {
            whitespace()
            val key = stringValue()
            whitespace()
            require(input.getOrNull(index++) == ':') { "expected colon" }
            values[key] = value()
            whitespace()
            when (input.getOrNull(index++)) {
                '}' -> return JsonValue.Object(values)
                ',' -> Unit
                else -> error("expected comma or object end")
            }
        }
    }

    private fun arrayValue(): JsonValue {
        index++
        val values = mutableListOf<JsonValue>()
        whitespace()
        if (input.getOrNull(index) == ']') {
            index++
            return JsonValue.Array(values)
        }
        while (true) {
            values += value()
            whitespace()
            when (input.getOrNull(index++)) {
                ']' -> return JsonValue.Array(values)
                ',' -> Unit
                else -> error("expected comma or array end")
            }
        }
    }

    private fun stringValue(): String {
        require(input.getOrNull(index++) == '"') { "expected string" }
        return buildString {
            while (true) {
                val character = input.getOrNull(index++) ?: error("unterminated string")
                when (character) {
                    '"' -> return@buildString
                    '\\\\' -> append(
                        when (val escaped = input.getOrNull(index++)) {
                            '"', '\\\\', '/' -> escaped
                            'b' -> '\\b'
                            'f' -> '\\u000C'
                            'n' -> '\\n'
                            'r' -> '\\r'
                            't' -> '\\t'
                            else -> error("unsupported escape")
                        },
                    )
                    else -> append(character)
                }
            }
        }
    }

    private fun numberValue(): JsonValue {
        val start = index
        while (input.getOrNull(index)?.let { it.isDigit() || it in ".-+eE" } == true) index++
        return JsonValue.Number(input.substring(start, index).toDouble())
    }

    private fun literal(text: String, value: JsonValue): JsonValue {
        require(input.startsWith(text, index)) { "invalid literal" }
        index += text.length
        return value
    }

    private fun whitespace() {
        while (input.getOrNull(index)?.isWhitespace() == true) index++
    }
}

${models}`;
}

function protocolReadme() {
  return `# VibeX Remote Protocol v1

This directory is generated by \`pnpm run remote-protocol-schema\`. The JSON
Schema and OpenAPI document are the versioned client contract; generated
TypeScript, Swift, and Kotlin files are compile-smoke fixtures, not mobile
product projects.

## Authentication and pairing

Normal HTTP calls use \`Authorization: Bearer <token>\`. WebSocket clients put
the token in the \`Sec-WebSocket-Protocol\` offer as
\`vibex.token.<base64url-token>\`; credentials are never accepted in a URL.

An authenticated administrator creates a five-minute pairing challenge with
\`POST /api/v1/auth/pairings\`. A device redeems the secret exactly once at
\`POST /api/v1/auth/pairings/redeem\`, receives only the approved scopes, and
can be revoked with \`DELETE /api/v1/auth/devices/{device_id}\`. Revocation is
enforced for both new HTTP requests and existing WebSocket connections.

## Durable replay and offline reads

Clients attach with the last persisted Conversation sequence they have
confirmed. They apply \`ready\`, optional snapshot, replay, high-water, then
live events in order, ignoring duplicates by sequence. \`RemoteEvent.kind\` is
open: unknown kinds and their JSON payloads must be retained or ignored without
making the cache unreadable. \`OfflineConversationCache.read_only\` must be
\`true\`; offline clients cannot queue writes through this contract.

Authenticated clients with \`offline.read\` call
\`GET /api/v1/conversations/{id}/offline?after_sequence=N\`. Clients with
\`notification.summary\` call
\`GET /api/v1/conversations/{id}/notification-summary\`.

\`TerminalNotificationSummary\` intentionally carries only stable ids,
terminal outcome, operation id, and time. It never carries prompt text, output,
diagnostics, file paths, tokens, or other secrets. VibeX does not connect this
contract to APNs or FCM.

## Compatibility

Clients must first call \`GET /api/v1/capabilities\` and compare
\`protocol_version\` and \`minimum_client_version\`. Unknown event kinds are
forward-compatible within v1. A new protocol major requires a new versioned
directory and explicit negotiation.

## Verification

\`\`\`bash
pnpm run remote-protocol-schema:check
\`\`\`

The check regenerates the artifacts and compiles the minimal TypeScript,
Swift, and Kotlin models. Kotlin compiler and Temurin JRE downloads are pinned
and SHA-256 verified when the host does not already provide them.
`;
}

function writeModels(output, schema) {
  const generated = path.join(output, 'generated');
  const files = new Map([
    ['typescript/RemoteProtocolModels.ts', typescriptModels(schema)],
    ['swift/RemoteProtocolModels.swift', swiftModels(schema)],
    ['kotlin/RemoteProtocolModels.kt', kotlinModels(schema)],
  ]);
  for (const [relative, contents] of files) {
    const target = path.join(generated, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  fs.writeFileSync(path.join(output, 'README.md'), protocolReadme());
}

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(target) : [target];
    })
    .sort();
}

function compareTrees(actual, expected) {
  const actualFiles = filesBelow(actual).map((file) => path.relative(actual, file));
  const expectedFiles = filesBelow(expected).map((file) =>
    path.relative(expected, file),
  );
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `generated protocol file set differs\nexpected: ${expectedFiles.join(
        ', ',
      )}\nactual: ${actualFiles.join(', ')}`,
    );
  }
  for (const relative of expectedFiles) {
    const left = fs.readFileSync(path.join(actual, relative));
    const right = fs.readFileSync(path.join(expected, relative));
    if (!left.equals(right)) {
      throw new Error(
        `${path.join('docs/protocol/v1', relative)} is stale; run pnpm run remote-protocol-schema`,
      );
    }
  }
}

function commandOnPath(command) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(locator, [command], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
}

function resolveKotlinCompiler() {
  if (process.env.VIBEX_KOTLINC) return process.env.VIBEX_KOTLINC;
  const existing = commandOnPath('kotlinc');
  if (existing) return existing;

  const tools = path.join(root, 'target', 'tools');
  const archive = path.join(tools, `kotlin-compiler-${kotlinVersion}.zip`);
  const extracted = path.join(tools, `kotlin-compiler-${kotlinVersion}`);
  const compiler = path.join(
    extracted,
    'kotlinc',
    'bin',
    process.platform === 'win32' ? 'kotlinc.bat' : 'kotlinc',
  );
  if (fs.existsSync(compiler)) return compiler;

  fs.mkdirSync(tools, { recursive: true });
  if (!fs.existsSync(archive)) {
    const url = `https://github.com/JetBrains/kotlin/releases/download/v${kotlinVersion}/kotlin-compiler-${kotlinVersion}.zip`;
    run('curl', ['--fail', '--location', '--output', archive, url]);
  }
  const digest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(archive))
    .digest('hex');
  if (digest !== kotlinArchiveSha256) {
    throw new Error(`Kotlin compiler checksum mismatch: ${digest}`);
  }
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(extracted, { recursive: true });
  run('unzip', ['-q', archive, '-d', extracted]);
  return compiler;
}

function resolveJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const java = commandOnPath('java');
  if (java) {
    const probe = spawnSync(java, ['-version'], { encoding: 'utf8' });
    if (probe.status === 0) return undefined;
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(
      'a Java 21+ runtime is required for the Kotlin schema smoke test',
    );
  }

  const tools = path.join(root, 'target', 'tools');
  const archive = path.join(tools, `temurin-jre-${temurinVersion}-mac-arm64.tar.gz`);
  const extracted = path.join(tools, `temurin-jre-${temurinVersion}-mac-arm64`);
  const home = path.join(
    extracted,
    `jdk-${temurinVersion.replace('_', '+')}-jre`,
    'Contents',
    'Home',
  );
  if (fs.existsSync(path.join(home, 'bin', 'java'))) return home;

  fs.mkdirSync(tools, { recursive: true });
  if (!fs.existsSync(archive)) {
    const url =
      'https://github.com/adoptium/temurin21-binaries/releases/download/' +
      'jdk-21.0.11%2B10/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.11_10.tar.gz';
    run('curl', ['--fail', '--location', '--output', archive, url]);
  }
  const digest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(archive))
    .digest('hex');
  if (digest !== temurinMacArm64Sha256) {
    throw new Error(`Temurin JRE checksum mismatch: ${digest}`);
  }
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(extracted, { recursive: true });
  run('tar', ['-xzf', archive, '-C', extracted]);
  return home;
}

function compileModels(output) {
  const generated = path.join(output, 'generated');
  const fixture =
    '{"sequence":7,"kind":"future_event","payload":{"new_field":"kept"}}';
  const typescriptSmoke = path.join(output, 'RemoteProtocolSmoke.ts');
  fs.writeFileSync(
    typescriptSmoke,
    `import { RemoteEvent } from './generated/typescript/RemoteProtocolModels';
const event = JSON.parse(${JSON.stringify(fixture)}) as RemoteEvent;
if (event.kind !== 'future_event' || event.payload === null ||
    typeof event.payload !== 'object' || Array.isArray(event.payload) ||
    event.payload.new_field !== 'kept') throw new Error('unknown event decode failed');
const roundTrip = JSON.parse(JSON.stringify(event)) as RemoteEvent;
if (roundTrip.kind !== event.kind) throw new Error('unknown event round trip failed');
`,
  );
  const tsconfig = path.join(output, 'tsconfig.json');
  const typescriptOutput = path.join(output, 'typescript-smoke');
  fs.writeFileSync(
    tsconfig,
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'CommonJS',
          outDir: typescriptOutput,
          skipLibCheck: true,
        },
        files: [
          'generated/typescript/RemoteProtocolModels.ts',
          'RemoteProtocolSmoke.ts',
        ],
      },
      null,
      2,
    )}\n`,
  );
  const tsc = path.join(root, 'frontend', 'node_modules', '.bin', 'tsc');
  run(tsc, ['--project', tsconfig]);
  run(process.execPath, [path.join(typescriptOutput, 'RemoteProtocolSmoke.js')]);

  const swiftc = commandOnPath('swiftc');
  if (!swiftc) throw new Error('swiftc is required for the Swift schema smoke test');
  const swiftSmoke = path.join(output, 'main.swift');
  const swiftExecutable = path.join(output, 'remote-protocol-swift-smoke');
  fs.writeFileSync(
    swiftSmoke,
    `import Foundation

let fixture = ${JSON.stringify(fixture)}
let event = try JSONDecoder().decode(RemoteEvent.self, from: Data(fixture.utf8))
guard event.kind == "future_event" else { fatalError("unknown event decode failed") }
let encoded = try JSONEncoder().encode(event)
let roundTrip = try JSONDecoder().decode(RemoteEvent.self, from: encoded)
guard roundTrip.kind == event.kind else { fatalError("unknown event round trip failed") }
`,
  );
  run(swiftc, [
    path.join(generated, 'swift', 'RemoteProtocolModels.swift'),
    swiftSmoke,
    '-o',
    swiftExecutable,
  ]);
  run(swiftExecutable, []);

  const kotlinc = resolveKotlinCompiler();
  const javaHome = resolveJavaHome();
  const kotlinSmoke = path.join(output, 'RemoteProtocolSmoke.kt');
  const kotlinOutput = path.join(output, 'remote-protocol-models.jar');
  fs.writeFileSync(
    kotlinSmoke,
    `package dev.vibex.remote.v1

fun main() {
    val event = RemoteEvent.decodeJson(${JSON.stringify(fixture)})
    check(event.kind == "future_event")
    val payload = event.payload as JsonValue.Object
    check((payload.value["new_field"] as JsonValue.Text).value == "kept")
    val roundTrip = RemoteEvent.decodeJson(event.encodeJson())
    check(roundTrip.kind == event.kind)
}
`,
  );
  const environment = javaHome
    ? { ...process.env, JAVA_HOME: javaHome }
    : process.env;
  run(
    kotlinc,
    [
      path.join(generated, 'kotlin', 'RemoteProtocolModels.kt'),
      kotlinSmoke,
      '-include-runtime',
      '-d',
      kotlinOutput,
    ],
    { env: environment },
  );
  const java = javaHome
    ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : commandOnPath('java');
  run(java, ['-jar', kotlinOutput], { env: environment });
}

function generate(output) {
  run('cargo', [
    'run',
    '--quiet',
    '-p',
    'remote-protocol',
    '--bin',
    'export_remote_protocol',
    '--',
    output,
  ]);
  const schema = JSON.parse(fs.readFileSync(path.join(output, 'schema.json')));
  requireDefinitions(schema);
  writeModels(output, schema);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-protocol-'));
try {
  const output = check ? temporary : checkedIn;
  generate(output);
  if (check) compareTrees(output, checkedIn);
  if (!skipCompile) compileModels(output);
  process.stdout.write(
    `${check ? 'verified' : 'generated'} remote protocol v1 artifacts\n`,
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
