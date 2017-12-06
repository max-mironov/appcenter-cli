import * as fs from "fs";
import * as path from "path";
import * as chalk from "chalk";
import * as xml2js from "xml2js";
import { out } from "../../../util/interaction";
import { isValidVersion } from "./validation-utils";
import { fileDoesNotExistOrIsDirectory } from "./file-utils";
var plist = require("plist");
var g2js = require("gradle-to-js/lib/parser");
var properties = require("properties");
var childProcess = require("child_process");

export var spawn = childProcess.spawn;

export interface VersionSearchParams {
  os: string; // ios or android
  plistFile: string;
  plistFilePrefix: string;
  gradleFile: string;
}

export function getReactNativeProjectAppVersion(versionSearchParams: VersionSearchParams, projectRoot?: string): Promise<string> {
  projectRoot = projectRoot || process.cwd();
  var projectPackageJson: any = require(path.join(projectRoot, "package.json"));
  var projectName: string = projectPackageJson.name;

  const fileExists = (file: string): boolean => {
    try { return fs.statSync(file).isFile() }
    catch (e) { return false }
  };

  out.text(chalk.cyan(`Detecting ${versionSearchParams.os} app version:\n`));

  if (versionSearchParams.os === "ios") {
    let resolvedPlistFile: string = versionSearchParams.plistFile;
    if (resolvedPlistFile) {
      // If a plist file path is explicitly provided, then we don't
      // need to attempt to "resolve" it within the well-known locations.
      if (!fileExists(resolvedPlistFile)) {
        throw new Error("The specified plist file doesn't exist. Please check that the provided path is correct.");
      }
    } else {
      // Allow the plist prefix to be specified with or without a trailing
      // separator character, but prescribe the use of a hyphen when omitted,
      // since this is the most commonly used convetion for plist files.
      if (versionSearchParams.plistFilePrefix && /.+[^-.]$/.test(versionSearchParams.plistFilePrefix)) {
        versionSearchParams.plistFilePrefix += "-";
      }

      const iOSDirectory: string = "ios";
      const plistFileName = `${versionSearchParams.plistFilePrefix || ""}Info.plist`;

      const knownLocations = [
        path.join(iOSDirectory, projectName, plistFileName),
        path.join(iOSDirectory, plistFileName)
      ];

      resolvedPlistFile = (<any>knownLocations).find(fileExists);

      if (!resolvedPlistFile) {
        throw new Error(`Unable to find either of the following plist files in order to infer your app's binary version: "${knownLocations.join("\", \"")}". If your plist has a different name, or is located in a different directory, consider using either the "--plist-file" or "--plist-file-prefix" parameters to help inform the CLI how to find it.`);
      }
    }

    const plistContents = fs.readFileSync(resolvedPlistFile).toString();

    try {
      var parsedPlist = plist.parse(plistContents);
    } catch (e) {
      throw new Error(`Unable to parse "${resolvedPlistFile}". Please ensure it is a well-formed plist file.`);
    }

    if (parsedPlist && parsedPlist.CFBundleShortVersionString) {
      if (isValidVersion(parsedPlist.CFBundleShortVersionString)) {
        out.text(`Using the target binary version value "${parsedPlist.CFBundleShortVersionString}" from "${resolvedPlistFile}".\n`);
        return Promise.resolve(parsedPlist.CFBundleShortVersionString);
      } else {
        throw new Error(`The "CFBundleShortVersionString" key in the "${resolvedPlistFile}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`);
      }
    } else {
      throw new Error(`The "CFBundleShortVersionString" key doesn't exist within the "${resolvedPlistFile}" file.`);
    }
  } else if (versionSearchParams.os === "android") {
    let buildGradlePath: string = path.join("android", "app");
    if (versionSearchParams.gradleFile) {
      buildGradlePath = versionSearchParams.gradleFile;
    }
    if (fs.lstatSync(buildGradlePath).isDirectory()) {
      buildGradlePath = path.join(buildGradlePath, "build.gradle");
    }

    if (fileDoesNotExistOrIsDirectory(buildGradlePath)) {
      throw new Error(`Unable to find gradle file "${buildGradlePath}".`);
    }

    return g2js.parseFile(buildGradlePath)
      .catch(() => {
        throw new Error(`Unable to parse the "${buildGradlePath}" file. Please ensure it is a well-formed Gradle file.`);
      })
      .then((buildGradle: any) => {
        let versionName: string = null;

        // First 'if' statement was implemented as workaround for case
        // when 'build.gradle' file contains several 'android' nodes.
        // In this case 'buildGradle.android' prop represents array instead of object
        // due to parsing issue in 'g2js.parseFile' method.
        if (buildGradle.android instanceof Array) {
          for (var i = 0; i < buildGradle.android.length; i++) {
            var gradlePart = buildGradle.android[i];
            if (gradlePart.defaultConfig && gradlePart.defaultConfig.versionName) {
              versionName = gradlePart.defaultConfig.versionName;
              break;
            }
          }
        } else if (buildGradle.android && buildGradle.android.defaultConfig && buildGradle.android.defaultConfig.versionName) {
          versionName = buildGradle.android.defaultConfig.versionName;
        } else {
          throw new Error(`The "${buildGradlePath}" file doesn't specify a value for the "android.defaultConfig.versionName" property.`);
        }

        if (typeof versionName !== "string") {
          throw new Error(`The "android.defaultConfig.versionName" property value in "${buildGradlePath}" is not a valid string. If this is expected, consider using the --target-binary-version option to specify the value manually.`);
        }

        let appVersion: string = versionName.replace(/"/g, "").trim();

        if (isValidVersion(appVersion)) {
          // The versionName property is a valid semver string,
          // so we can safely use that and move on.
          out.text(`Using the target binary version value "${appVersion}" from "${buildGradlePath}".\n`);
          return appVersion;
        }

        // The version property isn't a valid semver string
        // so we assume it is a reference to a property variable.
        const propertyName = appVersion.replace("project.", "");
        const propertiesFileName = "gradle.properties";

        const knownLocations = [
          path.join("android", "app", propertiesFileName),
          path.join("android", propertiesFileName)
        ];

        // Search for gradle properties across all `gradle.properties` files
        var propertiesFile: string = null;
        for (var i = 0; i < knownLocations.length; i++) {
          propertiesFile = knownLocations[i];
          if (fileExists(propertiesFile)) {
            const propertiesContent: string = fs.readFileSync(propertiesFile).toString();
            try {
              const parsedProperties: any = properties.parse(propertiesContent);
              appVersion = parsedProperties[propertyName];
              if (appVersion) {
                break;
              }
            } catch (e) {
              throw new Error(`Unable to parse "${propertiesFile}". Please ensure it is a well-formed properties file.`);
            }
          }
        }

        if (!appVersion) {
          throw new Error(`No property named "${propertyName}" exists in the "${propertiesFile}" file.`);
        }

        if (!isValidVersion(appVersion)) {
          throw new Error(`The "${propertyName}" property in the "${propertiesFile}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`);
        }

        out.text(`Using the target binary version value "${appVersion}" from the "${propertyName}" key in the "${propertiesFile}" file.\n`);
        return appVersion.toString();
      });
  } else {
    var appxManifestFileName: string = "Package.appxmanifest";
    try {
      var appxManifestContainingFolder: string = path.join("windows", projectName);
      var appxManifestContents: string = fs.readFileSync(path.join(appxManifestContainingFolder, "Package.appxmanifest")).toString();
    } catch (err) {
      throw new Error(`Unable to find or read "${appxManifestFileName}" in the "${path.join("windows", projectName)}" folder.`);
    }

    xml2js.parseString(appxManifestContents, (err: Error, parsedAppxManifest: any) => {
      if (err) {
        throw new Error(`Unable to parse the "${path.join(appxManifestContainingFolder, appxManifestFileName)}" file, it could be malformed.`);
      }
      try {
        return parsedAppxManifest.Package.Identity[0]["$"].Version.match(/^\d+\.\d+\.\d+/)[0];
      } catch (e) {
        throw new Error(`Unable to parse the package version from the "${path.join(appxManifestContainingFolder, appxManifestFileName)}" file.`);
      }
    });
  }
}

export function runReactNativeBundleCommand(bundleName: string, development: boolean, entryFile: string, outputFolder: string, platform: string, sourcemapOutput: string): Promise<void> {
  let reactNativeBundleArgs: string[] = [];
  let envNodeArgs: string = process.env.CODE_PUSH_NODE_ARGS;

  if (typeof envNodeArgs !== "undefined") {
      Array.prototype.push.apply(reactNativeBundleArgs, envNodeArgs.trim().split(/\s+/));
  }

  Array.prototype.push.apply(reactNativeBundleArgs, [
      path.join("node_modules", "react-native", "local-cli", "cli.js"), "bundle",
      "--assets-dest", outputFolder,
      "--bundle-output", path.join(outputFolder, bundleName),
      "--dev", development,
      "--entry-file", entryFile,
      "--platform", platform,
  ]);

  if (sourcemapOutput) {
      reactNativeBundleArgs.push("--sourcemap-output", sourcemapOutput);
  }

  out.text(chalk.cyan("Running \"react-native bundle\" command:\n"));
  var reactNativeBundleProcess = spawn("node", reactNativeBundleArgs);
  out.text(`node ${reactNativeBundleArgs.join(" ")}`);

  return new Promise<void>((resolve, reject) => {
      reactNativeBundleProcess.stdout.on("data", (data: Buffer) => {
        out.text(data.toString().trim());
      });

      reactNativeBundleProcess.stderr.on("data", (data: Buffer) => {
          console.error(data.toString().trim());
      });

      reactNativeBundleProcess.on("close", (exitCode: number) => {
          if (exitCode) {
              reject(new Error(`"react-native bundle" command exited with code ${exitCode}.`));
          }

          resolve(<void>null);
      });
  });
}

export function isValidOS(os: string): boolean {
  switch (os.toLowerCase()) {
    case "android":
    case "ios":
    case "windows":
      return true;
    default:
      return false;
  }
}

export function isValidPlatform(platform: string): boolean {
  return platform.toLowerCase() == "react-native";
}

export function isReactNativeProject(): boolean {
  try {
    var projectPackageJson: any = require(path.join(process.cwd(), "package.json"));
    var projectName: string = projectPackageJson.name;
    if (!projectName) {
      throw new Error(`The "package.json" file in the CWD does not have the "name" field set.`);
    }

    return projectPackageJson.dependencies["react-native"] || (projectPackageJson.devDependencies && projectPackageJson.devDependencies["react-native"]);
  } catch (error) {
    throw new Error(`Unable to find or read "package.json" in the CWD. The "release-react" command must be executed in a React Native project folder.`);
  }
}
