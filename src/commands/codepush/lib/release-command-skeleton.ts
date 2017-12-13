import { AppCommand, CommandResult, ErrorCodes, failure, hasArg, help, longName, shortName, success, defaultValue } from "../../../util/commandline";
import { CommandArgs } from "../../../util/commandline/command";
import { AppCenterClient, models, clientRequest } from "../../../util/apis";
import { out, prompt } from "../../../util/interaction";
import { getUser, DefaultApp } from "../../../util/profile/index";
import { inspect } from "util";
import * as fs from "fs";
import * as path from "path";
import * as pfs from "../../../util/misc/promisfied-fs";
import * as chalk from "chalk";
import { sign, zip } from "../lib/update-contents-tasks";
import { isBinaryOrZip } from "../lib/file-utils";
import { environments } from "../lib/environment";
import { isValidRange, isValidRollout, isValidDeployment } from "../lib/validation-utils";
import FileUploadClient, { MessageLevel, IUploadStats } from "file-upload-client";
import { ReleaseUploadBeginResponse } from "../../../util/apis/generated/models/index";

const debug = require("debug")("appcenter-cli:commands:codepush:release-skeleton");

export default class CodePushReleaseCommandSkeleton extends AppCommand {
  @help("Deployment to release the update to")
  @shortName("d")
  @longName("deployment-name")
  @defaultValue("Staging")
  @hasArg
  public specifiedDeploymentName: string;

  @help("Description of the changes made to the app in this release")
  @longName("description")
  @hasArg
  public description: string;

  @help("Specifies whether this release should be immediately downloadable")
  @shortName("x")
  @longName("disabled")
  public disabled: boolean;

  @help("Specifies whether this release should be considered mandatory")
  @shortName("m")
  @longName("mandatory")
  public mandatory: boolean;

  @help("Specifies the location of a RSA private key to sign the release with." + chalk.yellow("NOTICE:") + " use it for react native applications only, client SDK on other platforms will be ignoring signature verification for now!")
  @shortName("k")
  @longName("private-key-path")
  @hasArg
  public privateKeyPath: string;

  @help("When this flag is set, releasing a package that is identical to the latest release will produce a warning instead of an error")
  @longName("no-duplicate-release-error")
  public noDuplicateReleaseError: boolean;

  @help("Percentage of users this release should be available to")
  @shortName("r")
  @longName("rollout")
  @defaultValue("100")
  @hasArg
  public specifiedRollout: string;

  protected rollout: number;

  // We assume that if this field is assigned than it is already validated (help us not to validate twice).
  protected deploymentName: string;

  protected updateContentsPath: string;

  protected targetBinaryVersion: string;

  constructor(args: CommandArgs) {
    super(args);
  }
  
  public async run(client: AppCenterClient): Promise<CommandResult> {
    throw new Error("For dev purposes only!");
  }

  protected async release(client: AppCenterClient): Promise<CommandResult> {
    this.rollout = Number(this.specifiedRollout);

    const validationResult: CommandResult =  await this.validate(client);
    if (!validationResult.succeeded) return validationResult;

    this.deploymentName = this.specifiedDeploymentName;

    if (this.privateKeyPath) {
      await sign(this.privateKeyPath, this.updateContentsPath);
    }

    const updateContentsZipPath = await zip(this.updateContentsPath);
    try {
      const app: DefaultApp = this.app;
      const httpRequest: any = await clientRequest<models.FileAsset>((cb) => client.releaseUploads.create(app.ownerName, app.appName, cb));

      let uploadClientSettings: any;
      try {
         uploadClientSettings = JSON.parse(httpRequest.response.body);
      } catch (e) {
        return failure(ErrorCodes.Exception, "Failed to create a CodePush release. Failed to parse create_asset response from server.");
      }
      const uploadPromise = (): Promise<string> => {
          return new Promise<string>((resolve, reject) => {
            try {
              const uploadClient = new FileUploadClient({
                assetId: uploadClientSettings.asset_id,
                assetDomain: uploadClientSettings.asset_domain,
                assetToken: uploadClientSettings.asset_token,
                onCompleted: (data: IUploadStats) => {
                  return resolve(data.downloadUrl);
                },
                onMessage: (message: string, messageLevel: MessageLevel) => {
                  if (messageLevel === MessageLevel.Error) {
                    return reject(`Failed to release a CodePush update: ${message}`);
                  }
                }
              });

              uploadClient.upload({
                arrayBuffer: fs.readFileSync(updateContentsZipPath),
                fileName: path.basename(updateContentsZipPath, '.zip'),
                size: fs.statSync(updateContentsZipPath).size
              });          
            } catch (ex) {
              return reject(`Failed to release a CodePush update: ${ex.message}`);
            }
        });
      }

      const uploadAndRelase = async () => {
        const downloadBlobUrl: string = await uploadPromise();
        await clientRequest<models.CodePushRelease>(
          (cb) => client.codePushDeploymentReleases.create(
            this.deploymentName,
            this.targetBinaryVersion,
            app.ownerName,
            app.appName,
            {
              deploymentName1: this.deploymentName,
              description: this.description,
              disabled: this.disabled, 
              mandatory: this.mandatory, 
              rollout: this.rollout,
              packageParameter: fs.createReadStream(updateContentsZipPath), // TODO: remove this when update codepush-distribution service 
              // blobUrl: downloadBlobUrl TODO: could be added when update swagger for codepush-distribution
            }, cb));   
      }

      await out.progress("Creating CodePush release...", uploadAndRelase());
      out.text(`Successfully released an update containing the "${this.updateContentsPath}" `
        + `${fs.lstatSync(this.updateContentsPath).isDirectory() ? "directory" : "file"}`
        + ` to the "${this.deploymentName}" deployment of the "${this.app.appName}" app.`);

      return success();
    } catch (error) {
      debug(`Failed to release a CodePush update - ${inspect(error)}`);
      return failure(ErrorCodes.Exception, error.response ? error.response.body : error);
    } finally {
      await pfs.rmDir(updateContentsZipPath);
    }
  }

  private async validate(client: AppCenterClient): Promise<CommandResult> {
    if (isBinaryOrZip(this.updateContentsPath)) {
      return failure(ErrorCodes.InvalidParameter, "It is unnecessary to package releases in a .zip or binary file. Please specify the direct path to the update content's directory (e.g. /platforms/ios/www) or file (e.g. main.jsbundle).");
    }

    if (!isValidRange(this.targetBinaryVersion)) {
      return failure(ErrorCodes.InvalidParameter, "Invalid binary version(s) for a release.");
    }

    if (!Number.isSafeInteger(this.rollout) || !isValidRollout(this.rollout)) {
      return failure(ErrorCodes.InvalidParameter, `Rollout value should be integer value between ${chalk.bold('0')} or ${chalk.bold('100')}.`);
    }

    if (!this.deploymentName && !(await isValidDeployment(client, this.app, this.specifiedDeploymentName))) {
      return failure(ErrorCodes.InvalidParameter, `Deployment "${this.specifiedDeploymentName}" does not exist.`);
    } 

    return success();
  }
}