import { useShellEnv, useExecutableMarkdown, useVirtualEnv, useDownload, usePackageYAMLFrontMatter, usePantry } from "hooks"
import useFlags, { Args } from "hooks/useFlags.ts"
import { hydrate as base_hydrate, resolve, install as base_install, link } from "prefab"
import { Installation, PackageRequirement, PackageSpecification, Verbosity } from "types"
import { run, undent, pkg as pkgutils, RunError, TeaError, UsageError } from "utils"
import * as semver from "semver"
import Path from "path"
import { isNumber } from "is_what"
import { VirtualEnv } from "hooks/useVirtualEnv.ts"
import { red, gray, Logger } from "hooks/useLogger.ts"
import { Interpreter } from "hooks/usePantry.ts";

export default async function exec(opts: Args) {
  const { debug, verbosity, ...flags } = useFlags()
  const {args: cmd, pkgs: sparkles, blueprint, env: add_env} = await abracadabra(opts)

  const installations = await install([...sparkles, ...opts.pkgs, ...blueprint?.requirements ?? []])

  const env = Object.entries(useShellEnv({ installations })).reduce((memo, [k, v]) => {
    memo[k] = v.join(':')
    return memo
  }, {} as Record<string, string>)

  if (blueprint) {
    env["SRCROOT"] = blueprint.srcroot.string
    if (blueprint.version) env["VERSION"] = blueprint.version.toString()
  }
  if (flags.json) {
    env["JSON"] = "1"
  }
  if (add_env) {
    Object.assign(env, add_env)
  }
  if (blueprint) {
    // if already set we shouldn’t override it
    // however that changes behavior… so maybe we should?
    // quite possibly this will be fine since how would we find a requirementsFile if TEA_DIR was set someplace else?
    env["TEA_DIR"] ??= blueprint.requirementsFile.parent().string
  }

  try {
    if (cmd.length) {
      if (cmd[0] == '.') {
        // if we got here and `.` wasn’t converted into something else
        // then there was no default target or no exe/md and running `.`
        // will just give a cryptic message, so let’s provide a better one
        throw new TeaError('not-found: exe/md: default target', {opts})
      }

      await run({ cmd, env })  //TODO implement `execvp` for deno
    } else if (opts.pkgs.length) {
      await repl(installations, env)
    } else if (verbosity <= Verbosity.normal && !flags.sync) {
      // tea was called with no arguments we can use, eg. `tea`
      // so show usage and exit(1)
      // in quiet mode the usage output is actually eaten
      throw new UsageError()
    } else {
      // tea was called with something like `tea -v`
      // show version (this was already done higher up)
      // also this route for calling with `tea --sync`
    }
  } catch (err) {
    if (err instanceof TeaError || err instanceof UsageError) {
      throw err
    } else if (debug) {
      console.error(err)
    } else if (err instanceof Deno.errors.NotFound) {
      console.error("tea: command not found:", cmd[0])
    } else if (err instanceof RunError == false) {
      const decapitalize = ([first, ...rest]: string) => first.toLowerCase() + rest.join("")
      console.error(`${red("error")}:`, decapitalize(err.message))
    }
    const code = err?.code ?? 1
    Deno.exit(isNumber(code) ? code : 1)
  }
}

/////////////////////////////////////////////////////////////
async function install(dry: PackageSpecification[]) {
  const { wet } = await hydrate(dry)
  const gas = await resolve(wet.pkgs)  ; console.debug({gas})

  for (const pkg of gas.pending) {
    const rq = wet.pkgs.find(rq => rq.project == pkg.project)
    const logger = new Logger(pkgutils.str(rq ?? pkg))
    const installation = await base_install(pkg, logger)
    await link(installation)
    gas.installed.push(installation)
  }
  return gas.installed
}

export async function hydrate(dry: PackageSpecification[]) {
  const pantry = usePantry()

  // companions are eg cargo for rust, pip for python
  // users and other packages typically expect the companion so by default we just install them
  //TODO for v1 we may want to rework this concept
  //TODO this could be much more efficient with concurrency
  //NOTE considering them “dry” is perhaps not a good idea
  for (const pkg of [...dry]) {
    dry.push(...await pantry.getCompanions(pkg))
  }

  const wet = await base_hydrate(dry)  ; console.debug({wet})

  return {wet}
}


interface RV {
  args: string[]
  pkgs: PackageRequirement[]
  blueprint?: VirtualEnv
  env?: Record<string, string>
}


// this function is fragile, we need to write 100% coverage and then refactor
// the fragility is because our magic is not very well defined
async function abracadabra(opts: Args): Promise<RV> {
  const { magic, debug } = useFlags()
  const pkgs: PackageRequirement[] = []
  const args = [...opts.args]
  let add_env: Record<string, string> | undefined

  let env = magic && opts.env !== false ? await useVirtualEnv().swallow(/^not-found/) : undefined

  if (env && args.length) {
    const sh = await useExecutableMarkdown({ filename: env.requirementsFile }).findScript(args[0]).swallow(/exe\/md/)
    if (sh) {
      return mksh(sh, args)
    } else if (args.length == 0) {
      throw new TeaError('not-found: exe/md: default target', env)
    }
  }

  const path = await (async () => {
    if (args.length == 0) return
    const url = urlify(args[0])
    if (url) {
      const logger = url.path().basename()
      const path = await useDownload().download({ src: url, logger })
      args[0] = path.chmod(0o777).string
      return path
    } else {
      const path = Path.cwd().join(args[0])
      if (path.isDirectory()) {
        return path.join("README.md").isFile()
      } else {
        return path.isFile()
      }
    }
  })()

  if (path) {
    if (opts.env || isMarkdown(path)) {
      // for scripts, we ignore the working directory as virtual-env finder
      // and work from the script, note that the user had to `#!/usr/bin/env -S tea -E`
      // for that to happen so in the shebang we are having that explicitly set
      env = await useVirtualEnv({ cwd: path.parent() })

      //NOTE this maybe is wrong? maybe we should read the script and check if we were shebanged
      // with -E since `$ tea -E path/to/script` should perhaps use the active env?
    } else {
      //NOTE this REALLY may be wrong
      env = undefined
    }

    if (isMarkdown(path)) {
      // user has explicitly requested a markdown file
      const sh = await useExecutableMarkdown({ filename: path }).findScript(args[1])
      let args_ = args
      if (args[1]) {
        // we don’t want to pass the target-name to the script
        args_ = [args[0], ...args.slice(2)]
      }
      //TODO if no `env` then we should extract deps from the markdown obv.
      return mksh(sh, args_)

    } else {
      const yaml = await usePackageYAMLFrontMatter(path, env?.srcroot)

      if (magic) {
        // pushing at front so (any) later specification tromps it
        const unshift = ({ project, args: new_args }: Interpreter) => {
          if (!yaml?.pkgs.length) {
            pkgs.unshift({ project, constraint: new semver.Range("*") })
          }
          if (!yaml?.args.length) {
            args.unshift(...new_args)
          }
        }

        const interpreter = await usePantry().getInterpreter(path.extname())
        if (interpreter) unshift(interpreter)
      }

      if (yaml) {
        args.unshift(...yaml.args)
        pkgs.push(...yaml.pkgs)
        add_env = yaml.env
      }
    }
  }

  return {args, pkgs, blueprint: env, env: add_env}

  function isMarkdown(path: Path) {
    //ref: https://superuser.com/a/285878
    switch (path.extname()) {
    case ".md":
    case '.mkd':
    case '.mdwn':
    case '.mdown':
    case '.mdtxt':
    case '.mdtext':
    case '.markdown':
    case '.text':
    case '.md.txt':
      return true
    }
  }

  function mksh(sh: string, args: string[]) {
    //TODO no need to make the file, just pipe to stdin
    //TODO should be able to specify script types
    const [arg0, ...argv] = args

    //FIXME won’t work as expected for various scenarios
    // but not sure how else to represent this without adding an explcit requirement for "$@" in the script
    // or without parsing the script to determine where to insert "$@"
    // simple example of something difficult would be a for loop since it ends with `done` so we can't just stick the "$@" at the end of the last line
    const oneliner = (() => {
      const lines = sh.split("\n")
      for (const line of lines.slice(0, -1)) {
        if (!line.trim().endsWith("\\")) return false
      }
      return true
    })()

    //FIXME putting "$@" at the end can be invalid, it really depends on the script TBH
    //FIXME shouldn’t necessarily default to bash

    // This is short term until a longer term fix is available through a deno library
    const saferArg0 = arg0.replaceAll("/", "_").replaceAll(".", "-")

    const path = Path.mktmp().join(saferArg0).write({ force: true, text: undent`
      #!/bin/bash
      set -e
      ${debug ? "set -x" : ""}
      ${sh} ${oneliner ? '"$@"' : ''}
      ` }).chmod(0o500)

    return {
      args: [path.string, ...argv],
      pkgs,
      blueprint: env
    }
  }
}

function urlify(arg0: string) {
  try {
    const url = new URL(arg0)
    // we do some magic so github URLs are immediately usable
    switch (url.host) {
    case "github.com":
      url.host = "raw.githubusercontent.com"
      url.pathname = url.pathname.replace("/blob/", "/")
      break
    case "gist.github.com":
      url.host = "gist.githubusercontent.com"
      //FIXME this is not good enough
      //REF: https://gist.github.com/atenni/5604615
      url.pathname += "/raw"
      break
    }
    return url
  } catch {
    //noop
  }
}

import { basename } from "deno/path/mod.ts"

async function repl(installations: Installation[], env: Record<string, string>) {
  const pkgs_str = () => installations.map(({pkg}) => gray(pkgutils.str(pkg))).join(", ")
  console.info('this is a temporary shell containing the following packages:')
  console.info(pkgs_str())
  console.info("when done type: `exit'")
  const shell = Deno.env.get("SHELL")?.trim() || "/bin/sh"
  const cmd = [shell, '-i'] // interactive

  //TODO other shells pls #help-wanted

  switch (basename(shell)) {
  case 'zsh':
    env['PS1'] = "%F{086}tea%F{reset} %~ "
    cmd.push('--no-rcs', '--no-globalrcs')
    break
  case 'fish':
    cmd.push(
      '--no-config',
      '--init-command',
      'function fish_prompt; set_color 5fffd7; echo -n "tea"; set_color grey; echo " %~ "; end'
      )
  }

  await run({ cmd, env })
}
