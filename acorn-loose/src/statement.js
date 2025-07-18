import {LooseParser} from "./state.js"
import {isDummy} from "./parseutil.js"
import {getLineInfo, tokTypes as tt} from "acorn"

const lp = LooseParser.prototype

lp.parseTopLevel = function() {
  let node = this.startNodeAt(this.options.locations ? [0, getLineInfo(this.input, 0)] : 0)
  node.body = []
  while (this.tok.type !== tt.eof) node.body.push(this.parseStatement())
  this.toks.adaptDirectivePrologue(node.body)
  this.last = this.tok
  node.sourceType = this.options.sourceType === "commonjs" ? "script" : this.options.sourceType
  return this.finishNode(node, "Program")
}

lp.parseStatement = function() {
  let starttype = this.tok.type, node = this.startNode(), kind

  if (this.toks.isLet()) {
    starttype = tt._var
    kind = "let"
  }

  switch (starttype) {
  case tt._break: case tt._continue:
    this.next()
    let isBreak = starttype === tt._break
    if (this.semicolon() || this.canInsertSemicolon()) {
      node.label = null
    } else {
      node.label = this.tok.type === tt.name ? this.parseIdent() : null
      this.semicolon()
    }
    return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement")

  case tt._debugger:
    this.next()
    this.semicolon()
    return this.finishNode(node, "DebuggerStatement")

  case tt._do:
    this.next()
    node.body = this.parseStatement()
    node.test = this.eat(tt._while) ? this.parseParenExpression() : this.dummyIdent()
    this.semicolon()
    return this.finishNode(node, "DoWhileStatement")

  case tt._for:
    this.next() // `for` keyword
    let isAwait = this.options.ecmaVersion >= 9 && this.eatContextual("await")

    this.pushCx()
    this.expect(tt.parenL)
    if (this.tok.type === tt.semi) return this.parseFor(node, null)
    let isLet = this.toks.isLet()
    let isAwaitUsing = this.toks.isAwaitUsing(true)
    let isUsing = !isAwaitUsing && this.toks.isUsing(true)

    if (isLet || this.tok.type === tt._var || this.tok.type === tt._const || isUsing || isAwaitUsing) {
      let kind = isLet ? "let" : isUsing ? "using" : isAwaitUsing ? "await using" : this.tok.value
      let init = this.startNode()
      if (isUsing || isAwaitUsing) {
        if (isAwaitUsing) this.next()
        this.parseVar(init, true, kind)
      } else {
        init = this.parseVar(init, true, kind)
      }

      if (init.declarations.length === 1 && (this.tok.type === tt._in || this.isContextual("of"))) {
        if (this.options.ecmaVersion >= 9 && this.tok.type !== tt._in) {
          node.await = isAwait
        }
        return this.parseForIn(node, init)
      }
      return this.parseFor(node, init)
    }
    let init = this.parseExpression(true)
    if (this.tok.type === tt._in || this.isContextual("of")) {
      if (this.options.ecmaVersion >= 9 && this.tok.type !== tt._in) {
        node.await = isAwait
      }
      return this.parseForIn(node, this.toAssignable(init))
    }
    return this.parseFor(node, init)

  case tt._function:
    this.next()
    return this.parseFunction(node, true)

  case tt._if:
    this.next()
    node.test = this.parseParenExpression()
    node.consequent = this.parseStatement()
    node.alternate = this.eat(tt._else) ? this.parseStatement() : null
    return this.finishNode(node, "IfStatement")

  case tt._return:
    this.next()
    if (this.eat(tt.semi) || this.canInsertSemicolon()) node.argument = null
    else { node.argument = this.parseExpression(); this.semicolon() }
    return this.finishNode(node, "ReturnStatement")

  case tt._switch:
    let blockIndent = this.curIndent, line = this.curLineStart
    this.next()
    node.discriminant = this.parseParenExpression()
    node.cases = []
    this.pushCx()
    this.expect(tt.braceL)

    let cur
    while (!this.closes(tt.braceR, blockIndent, line, true)) {
      if (this.tok.type === tt._case || this.tok.type === tt._default) {
        let isCase = this.tok.type === tt._case
        if (cur) this.finishNode(cur, "SwitchCase")
        node.cases.push(cur = this.startNode())
        cur.consequent = []
        this.next()
        if (isCase) cur.test = this.parseExpression()
        else cur.test = null
        this.expect(tt.colon)
      } else {
        if (!cur) {
          node.cases.push(cur = this.startNode())
          cur.consequent = []
          cur.test = null
        }
        cur.consequent.push(this.parseStatement())
      }
    }
    if (cur) this.finishNode(cur, "SwitchCase")
    this.popCx()
    this.eat(tt.braceR)
    return this.finishNode(node, "SwitchStatement")

  case tt._throw:
    this.next()
    node.argument = this.parseExpression()
    this.semicolon()
    return this.finishNode(node, "ThrowStatement")

  case tt._try:
    this.next()
    node.block = this.parseBlock()
    node.handler = null
    if (this.tok.type === tt._catch) {
      let clause = this.startNode()
      this.next()
      if (this.eat(tt.parenL)) {
        clause.param = this.toAssignable(this.parseExprAtom(), true)
        this.expect(tt.parenR)
      } else {
        clause.param = null
      }
      clause.body = this.parseBlock()
      node.handler = this.finishNode(clause, "CatchClause")
    }
    node.finalizer = this.eat(tt._finally) ? this.parseBlock() : null
    if (!node.handler && !node.finalizer) return node.block
    return this.finishNode(node, "TryStatement")

  case tt._var:
  case tt._const:
    return this.parseVar(node, false, kind || this.tok.value)

  case tt._while:
    this.next()
    node.test = this.parseParenExpression()
    node.body = this.parseStatement()
    return this.finishNode(node, "WhileStatement")

  case tt._with:
    this.next()
    node.object = this.parseParenExpression()
    node.body = this.parseStatement()
    return this.finishNode(node, "WithStatement")

  case tt.braceL:
    return this.parseBlock()

  case tt.semi:
    this.next()
    return this.finishNode(node, "EmptyStatement")

  case tt._class:
    return this.parseClass(true)

  case tt._import:
    if (this.options.ecmaVersion > 10) {
      const nextType = this.lookAhead(1).type
      if (nextType === tt.parenL || nextType === tt.dot) {
        node.expression = this.parseExpression()
        this.semicolon()
        return this.finishNode(node, "ExpressionStatement")
      }
    }

    return this.parseImport()

  case tt._export:
    return this.parseExport()

  default:
    if (this.toks.isAsyncFunction()) {
      this.next()
      this.next()
      return this.parseFunction(node, true, true)
    }

    if (this.toks.isUsing(false)) {
      return this.parseVar(node, false, "using")
    }

    if (this.toks.isAwaitUsing(false)) {
      this.next()
      return this.parseVar(node, false, "await using")
    }

    let expr = this.parseExpression()
    if (isDummy(expr)) {
      this.next()
      if (this.tok.type === tt.eof) return this.finishNode(node, "EmptyStatement")
      return this.parseStatement()
    } else if (starttype === tt.name && expr.type === "Identifier" && this.eat(tt.colon)) {
      node.body = this.parseStatement()
      node.label = expr
      return this.finishNode(node, "LabeledStatement")
    } else {
      node.expression = expr
      this.semicolon()
      return this.finishNode(node, "ExpressionStatement")
    }
  }
}

lp.parseBlock = function() {
  let node = this.startNode()
  this.pushCx()
  this.expect(tt.braceL)
  let blockIndent = this.curIndent, line = this.curLineStart
  node.body = []
  while (!this.closes(tt.braceR, blockIndent, line, true))
    node.body.push(this.parseStatement())
  this.popCx()
  this.eat(tt.braceR)
  return this.finishNode(node, "BlockStatement")
}

lp.parseFor = function(node, init) {
  node.init = init
  node.test = node.update = null
  if (this.eat(tt.semi) && this.tok.type !== tt.semi) node.test = this.parseExpression()
  if (this.eat(tt.semi) && this.tok.type !== tt.parenR) node.update = this.parseExpression()
  this.popCx()
  this.expect(tt.parenR)
  node.body = this.parseStatement()
  return this.finishNode(node, "ForStatement")
}

lp.parseForIn = function(node, init) {
  let type = this.tok.type === tt._in ? "ForInStatement" : "ForOfStatement"
  this.next()
  node.left = init
  node.right = this.parseExpression()
  this.popCx()
  this.expect(tt.parenR)
  node.body = this.parseStatement()
  return this.finishNode(node, type)
}

lp.parseVar = function(node, noIn, kind) {
  node.kind = kind
  this.next()
  node.declarations = []
  do {
    let decl = this.startNode()
    decl.id = this.options.ecmaVersion >= 6 ? this.toAssignable(this.parseExprAtom(), true) : this.parseIdent()
    decl.init = this.eat(tt.eq) ? this.parseMaybeAssign(noIn) : null
    node.declarations.push(this.finishNode(decl, "VariableDeclarator"))
  } while (this.eat(tt.comma))
  if (!node.declarations.length) {
    let decl = this.startNode()
    decl.id = this.dummyIdent()
    node.declarations.push(this.finishNode(decl, "VariableDeclarator"))
  }
  if (!noIn) this.semicolon()
  return this.finishNode(node, "VariableDeclaration")
}

lp.parseClass = function(isStatement) {
  let node = this.startNode()
  this.next()
  if (this.tok.type === tt.name) node.id = this.parseIdent()
  else if (isStatement === true) node.id = this.dummyIdent()
  else node.id = null
  node.superClass = this.eat(tt._extends) ? this.parseExpression() : null
  node.body = this.startNode()
  node.body.body = []
  this.pushCx()
  let indent = this.curIndent + 1, line = this.curLineStart
  this.eat(tt.braceL)
  if (this.curIndent + 1 < indent) { indent = this.curIndent; line = this.curLineStart }
  while (!this.closes(tt.braceR, indent, line)) {
    const element = this.parseClassElement()
    if (element) node.body.body.push(element)
  }
  this.popCx()
  if (!this.eat(tt.braceR)) {
    // If there is no closing brace, make the node span to the start
    // of the next token (this is useful for Tern)
    this.last.end = this.tok.start
    if (this.options.locations) this.last.loc.end = this.tok.loc.start
  }
  this.semicolon()
  this.finishNode(node.body, "ClassBody")
  return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression")
}

lp.parseClassElement = function() {
  if (this.eat(tt.semi)) return null

  const {ecmaVersion, locations} = this.options
  const indent = this.curIndent
  const line = this.curLineStart
  const node = this.startNode()
  let keyName = ""
  let isGenerator = false
  let isAsync = false
  let kind = "method"
  let isStatic = false

  if (this.eatContextual("static")) {
    // Parse static init block
    if (ecmaVersion >= 13 && this.eat(tt.braceL)) {
      this.parseClassStaticBlock(node)
      return node
    }
    if (this.isClassElementNameStart() || this.toks.type === tt.star) {
      isStatic = true
    } else {
      keyName = "static"
    }
  }
  node.static = isStatic
  if (!keyName && ecmaVersion >= 8 && this.eatContextual("async")) {
    if ((this.isClassElementNameStart() || this.toks.type === tt.star) && !this.canInsertSemicolon()) {
      isAsync = true
    } else {
      keyName = "async"
    }
  }
  if (!keyName) {
    isGenerator = this.eat(tt.star)
    const lastValue = this.toks.value
    if (this.eatContextual("get") || this.eatContextual("set")) {
      if (this.isClassElementNameStart()) {
        kind = lastValue
      } else {
        keyName = lastValue
      }
    }
  }

  // Parse element name
  if (keyName) {
    // 'async', 'get', 'set', or 'static' were not a keyword contextually.
    // The last token is any of those. Make it the element name.
    node.computed = false
    node.key = this.startNodeAt(locations ? [this.toks.lastTokStart, this.toks.lastTokStartLoc] : this.toks.lastTokStart)
    node.key.name = keyName
    this.finishNode(node.key, "Identifier")
  } else {
    this.parseClassElementName(node)

    // From https://github.com/acornjs/acorn/blob/7deba41118d6384a2c498c61176b3cf434f69590/acorn-loose/src/statement.js#L291
    // Skip broken stuff.
    if (isDummy(node.key)) {
      if (isDummy(this.parseMaybeAssign())) this.next()
      this.eat(tt.comma)
      return null
    }
  }

  // Parse element value
  if (ecmaVersion < 13 || this.toks.type === tt.parenL || kind !== "method" || isGenerator || isAsync) {
    // Method
    const isConstructor =
      !node.computed &&
      !node.static &&
      !isGenerator &&
      !isAsync &&
      kind === "method" && (
        node.key.type === "Identifier" && node.key.name === "constructor" ||
        node.key.type === "Literal" && node.key.value === "constructor"
      )
    node.kind = isConstructor ? "constructor" : kind
    node.value = this.parseMethod(isGenerator, isAsync)
    this.finishNode(node, "MethodDefinition")
  } else {
    // Field
    if (this.eat(tt.eq)) {
      if (this.curLineStart !== line && this.curIndent <= indent && this.tokenStartsLine()) {
        // Estimated the next line is the next class element by indentations.
        node.value = null
      } else {
        const oldInAsync = this.inAsync
        const oldInGenerator = this.inGenerator
        this.inAsync = false
        this.inGenerator = false
        node.value = this.parseMaybeAssign()
        this.inAsync = oldInAsync
        this.inGenerator = oldInGenerator
      }
    } else {
      node.value = null
    }
    this.semicolon()
    this.finishNode(node, "PropertyDefinition")
  }

  return node
}

lp.parseClassStaticBlock = function(node) {
  let blockIndent = this.curIndent, line = this.curLineStart
  node.body = []
  this.pushCx()
  while (!this.closes(tt.braceR, blockIndent, line, true))
    node.body.push(this.parseStatement())
  this.popCx()
  this.eat(tt.braceR)

  return this.finishNode(node, "StaticBlock")
}

lp.isClassElementNameStart = function() {
  return this.toks.isClassElementNameStart()
}

lp.parseClassElementName = function(element) {
  if (this.toks.type === tt.privateId) {
    element.computed = false
    element.key = this.parsePrivateIdent()
  } else {
    this.parsePropertyName(element)
  }
}

lp.parseFunction = function(node, isStatement, isAsync) {
  let oldInAsync = this.inAsync, oldInGenerator = this.inGenerator, oldInFunction = this.inFunction
  this.initFunction(node)
  if (this.options.ecmaVersion >= 6) {
    node.generator = this.eat(tt.star)
  }
  if (this.options.ecmaVersion >= 8) {
    node.async = !!isAsync
  }
  if (this.tok.type === tt.name) node.id = this.parseIdent()
  else if (isStatement === true) node.id = this.dummyIdent()
  this.inAsync = node.async
  this.inGenerator = node.generator
  this.inFunction = true
  node.params = this.parseFunctionParams()
  node.body = this.parseBlock()
  this.toks.adaptDirectivePrologue(node.body.body)
  this.inAsync = oldInAsync
  this.inGenerator = oldInGenerator
  this.inFunction = oldInFunction
  return this.finishNode(node, isStatement ? "FunctionDeclaration" : "FunctionExpression")
}

lp.parseExport = function() {
  let node = this.startNode()
  this.next()
  if (this.eat(tt.star)) {
    if (this.options.ecmaVersion >= 11) {
      if (this.eatContextual("as")) {
        node.exported = this.parseExprAtom()
      } else {
        node.exported = null
      }
    }
    node.source = this.eatContextual("from") ? this.parseExprAtom() : this.dummyString()
    if (this.options.ecmaVersion >= 16)
      node.attributes = this.parseWithClause()
    this.semicolon()
    return this.finishNode(node, "ExportAllDeclaration")
  }
  if (this.eat(tt._default)) {
    // export default (function foo() {}) // This is FunctionExpression.
    let isAsync
    if (this.tok.type === tt._function || (isAsync = this.toks.isAsyncFunction())) {
      let fNode = this.startNode()
      this.next()
      if (isAsync) this.next()
      node.declaration = this.parseFunction(fNode, "nullableID", isAsync)
    } else if (this.tok.type === tt._class) {
      node.declaration = this.parseClass("nullableID")
    } else {
      node.declaration = this.parseMaybeAssign()
      this.semicolon()
    }
    return this.finishNode(node, "ExportDefaultDeclaration")
  }
  if (this.tok.type.keyword || this.toks.isLet() || this.toks.isAsyncFunction()) {
    node.declaration = this.parseStatement()
    node.specifiers = []
    node.source = null
  } else {
    node.declaration = null
    node.specifiers = this.parseExportSpecifierList()
    node.source = this.eatContextual("from") ? this.parseExprAtom() : null
    if (this.options.ecmaVersion >= 16)
      node.attributes = this.parseWithClause()
    this.semicolon()
  }
  return this.finishNode(node, "ExportNamedDeclaration")
}

lp.parseImport = function() {
  let node = this.startNode()
  this.next()
  if (this.tok.type === tt.string) {
    node.specifiers = []
    node.source = this.parseExprAtom()
  } else {
    let elt
    if (this.tok.type === tt.name && this.tok.value !== "from") {
      elt = this.startNode()
      elt.local = this.parseIdent()
      this.finishNode(elt, "ImportDefaultSpecifier")
      this.eat(tt.comma)
    }
    node.specifiers = this.parseImportSpecifiers()
    node.source = this.eatContextual("from") && this.tok.type === tt.string ? this.parseExprAtom() : this.dummyString()
    if (elt) node.specifiers.unshift(elt)
  }
  if (this.options.ecmaVersion >= 16)
    node.attributes = this.parseWithClause()
  this.semicolon()
  return this.finishNode(node, "ImportDeclaration")
}

lp.parseImportSpecifiers = function() {
  let elts = []
  if (this.tok.type === tt.star) {
    let elt = this.startNode()
    this.next()
    elt.local = this.eatContextual("as") ? this.parseIdent() : this.dummyIdent()
    elts.push(this.finishNode(elt, "ImportNamespaceSpecifier"))
  } else {
    let indent = this.curIndent, line = this.curLineStart, continuedLine = this.nextLineStart
    this.pushCx()
    this.eat(tt.braceL)
    if (this.curLineStart > continuedLine) continuedLine = this.curLineStart
    while (!this.closes(tt.braceR, indent + (this.curLineStart <= continuedLine ? 1 : 0), line)) {
      let elt = this.startNode()
      if (this.eat(tt.star)) {
        elt.local = this.eatContextual("as") ? this.parseModuleExportName() : this.dummyIdent()
        this.finishNode(elt, "ImportNamespaceSpecifier")
      } else {
        if (this.isContextual("from")) break
        elt.imported = this.parseModuleExportName()
        if (isDummy(elt.imported)) break
        elt.local = this.eatContextual("as") ? this.parseModuleExportName() : elt.imported
        this.finishNode(elt, "ImportSpecifier")
      }
      elts.push(elt)
      this.eat(tt.comma)
    }
    this.eat(tt.braceR)
    this.popCx()
  }
  return elts
}

lp.parseWithClause = function() {
  let nodes = []
  if (!this.eat(tt._with)) {
    return nodes
  }

  let indent = this.curIndent, line = this.curLineStart, continuedLine = this.nextLineStart
  this.pushCx()
  this.eat(tt.braceL)
  if (this.curLineStart > continuedLine) continuedLine = this.curLineStart
  while (!this.closes(tt.braceR, indent + (this.curLineStart <= continuedLine ? 1 : 0), line)) {
    const attr = this.startNode()
    attr.key = this.tok.type === tt.string ? this.parseExprAtom() : this.parseIdent()
    if (this.eat(tt.colon)) {
      if (this.tok.type === tt.string)
        attr.value = this.parseExprAtom()
      else attr.value = this.dummyString()
    } else {
      if (isDummy(attr.key)) break
      if (this.tok.type === tt.string)
        attr.value = this.parseExprAtom()
      else break
    }
    nodes.push(this.finishNode(attr, "ImportAttribute"))
    this.eat(tt.comma)
  }
  this.eat(tt.braceR)
  this.popCx()
  return nodes
}

lp.parseExportSpecifierList = function() {
  let elts = []
  let indent = this.curIndent, line = this.curLineStart, continuedLine = this.nextLineStart
  this.pushCx()
  this.eat(tt.braceL)
  if (this.curLineStart > continuedLine) continuedLine = this.curLineStart
  while (!this.closes(tt.braceR, indent + (this.curLineStart <= continuedLine ? 1 : 0), line)) {
    if (this.isContextual("from")) break
    let elt = this.startNode()
    elt.local = this.parseModuleExportName()
    if (isDummy(elt.local)) break
    elt.exported = this.eatContextual("as") ? this.parseModuleExportName() : elt.local
    this.finishNode(elt, "ExportSpecifier")
    elts.push(elt)
    this.eat(tt.comma)
  }
  this.eat(tt.braceR)
  this.popCx()
  return elts
}

lp.parseModuleExportName = function() {
  return this.options.ecmaVersion >= 13 && this.tok.type === tt.string
    ? this.parseExprAtom()
    : this.parseIdent()
}
